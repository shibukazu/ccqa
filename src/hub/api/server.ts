import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHealthHandler } from "./handlers/health.ts";
import {
  createGetArtifactFileHandler,
  createGetArtifactsArchiveHandler,
  createGetReportHandler,
  createGetRunHandler,
  createListRunsHandler,
  createOpenRunHandler,
  createPatchRunHandler,
  createPushRunHandler,
} from "./handlers/runs.ts";
import {
  createDeleteSessionHandler,
  createDeleteVariableHandler,
  createGetSessionHandler,
  createListSessionsHandler,
  createListVariablesHandler,
  createPutSessionHandler,
  createPutVariableHandler,
} from "./handlers/secrets.ts";
import { createListProfilesHandler, createListProjectsHandler } from "./handlers/projects.ts";
import {
  createDeletePromptHandler,
  createGetPromptHandler,
  createListPromptsHandler,
  createPutPromptHandler,
} from "./handlers/prompts.ts";
import {
  createDeletePerspectivesHandler,
  createGetPerspectivesHandler,
  createPatchPerspectivesNoteHandler,
  createPutPerspectivesHandler,
} from "./handlers/perspectives.ts";
import {
  createCreateLearningJobHandler,
  createGetLearningJobHandler,
  createListLearningJobsHandler,
} from "./handlers/learning-jobs.ts";
import {
  createDeleteActualCauseHandler,
  createGetTriageHandler,
  createImportActualCausesHandler,
  createPutActualCauseHandler,
} from "./handlers/triage.ts";
import { Router, type RouteContext } from "./router.ts";
import { extractToken, isValidToken } from "./auth.ts";
import { applyCors } from "./cors.ts";
import { HttpError, sendError } from "./respond.ts";
import { renderHubUi } from "../ui/index.ts";
import { LearningQueue } from "../core/queue.ts";
import { createLearningWorker } from "../core/learning-worker.ts";
import type { HubStorage } from "../core/storage/types.ts";

export interface HubServerConfig {
  storage: HubStorage;
  token: string;
  encryptionKey: Buffer | null;
  allowedOrigins: string[];
  maxPushBytes?: number;
}

/** Endpoints reachable without a token: the liveness probe and the bundled UI shell. */
const PUBLIC_PATHS = new Set(["/api/v1/health", "/"]);

export function createHubServer(config: HubServerConfig): Server {
  // The triage-learning queue: a single in-process worker that turns graded
  // triage into an analysis custom prompt. State lives in the JobStore, so a restart
  // recovers any job left mid-flight (swept to "failed" — its worker is gone).
  const queue = new LearningQueue(config.storage.jobs, createLearningWorker({ storage: config.storage }));
  queue.recoverFromRestart().catch((err) => {
    console.error("hub: learning-job recovery on startup failed:", err);
  });

  // Any run still "running" at startup was left mid-flight by a previous
  // process (this one never resumes a patch stream) — mark it failed so it
  // doesn't sit unpatchable-but-not-terminal forever. One run's failure to
  // flip must not block the others.
  config.storage.runs
    .list({ status: "running" })
    .then((runs) =>
      Promise.all(
        runs.map((r) =>
          config.storage.runs.update(r.id, { status: "failed" }).catch((err) => {
            console.error(`hub: failed to mark orphaned running run "${r.id}" as failed on startup:`, err);
          }),
        ),
      ),
    )
    .catch((err) => {
      console.error("hub: orphaned-running-run sweep on startup failed:", err);
    });

  const router = new Router();
  registerRoutes(router, config, queue);

  return createServer((req, res) => {
    // handleRequest catches everything itself; this is the last-resort guard
    // so that even a failure while *serializing* an error can't become an
    // unhandled rejection that kills the whole hub process.
    handleRequest(req, res, router, config).catch((err) => {
      console.error("hub: request handling failed:", err);
      res.destroy();
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  router: Router,
  config: HubServerConfig,
): Promise<void> {
  // The whole request path lives inside this try — routing and auth run
  // before any token check, so an error escaping from them would otherwise
  // be an unauthenticated crash vector.
  try {
    if (applyCors(req, res, config.allowedOrigins)) return;

    const url = new URL(req.url ?? "/", "http://localhost");
    const matched = router.match(req.method ?? "GET", url.pathname);
    if (!matched) {
      sendError(res, new HttpError(404, "not_found", `no route for ${req.method} ${url.pathname}`));
      return;
    }

    if (!PUBLIC_PATHS.has(url.pathname)) {
      const token = extractToken(req, url);
      if (!isValidToken(token, config.token)) {
        sendError(res, new HttpError(401, "unauthorized", "missing or invalid bearer token"));
        return;
      }
    }

    const ctx: RouteContext = { req, res, params: matched.params, url };
    await matched.handler(ctx);
  } catch (err) {
    // Expected client errors (HttpError 4xx) just get serialized; anything
    // else is a server-side fault the operator needs to see in the logs —
    // the client's generic 500 alone would leave it invisible.
    if (!(err instanceof HttpError)) {
      console.error(`hub: ${req.method} ${req.url} failed:`, err);
    }
    sendError(res, err);
  }
}

function registerRoutes(router: Router, config: HubServerConfig, queue: LearningQueue): void {
  const { storage } = config;

  router.get("/api/v1/health", createHealthHandler(() => queue.depth()));
  router.get("/", async (ctx) => {
    ctx.res.statusCode = 200;
    ctx.res.setHeader("Content-Type", "text/html; charset=utf-8");
    // The whole app is this one inlined HTML document; after a hub upgrade the
    // browser must re-fetch it, not serve a heuristically-cached old build (which
    // would leave stale UI + JS running against a newer API). no-cache forces a
    // revalidation each load; the payload is small so this is cheap.
    ctx.res.setHeader("Cache-Control", "no-cache");
    ctx.res.end(renderHubUi());
  });

  router.post("/api/v1/runs", createPushRunHandler({
    storage,
    ...(config.maxPushBytes ? { maxPushBytes: config.maxPushBytes } : {}),
  }));
  router.post("/api/v1/runs/open", createOpenRunHandler({ storage }));
  router.patch("/api/v1/runs/:id", createPatchRunHandler({
    storage,
    ...(config.maxPushBytes != null ? { maxPushBytes: config.maxPushBytes } : {}),
  }));
  router.get("/api/v1/runs", createListRunsHandler(storage));
  router.get("/api/v1/runs/:id", createGetRunHandler(storage));
  router.get("/api/v1/runs/:id/report", createGetReportHandler(storage));
  router.get("/api/v1/runs/:id/artifacts", createGetArtifactsArchiveHandler(storage));
  router.get("/api/v1/runs/:id/artifacts/*path", createGetArtifactFileHandler(storage));

  router.get("/api/v1/runs/:id/triage", createGetTriageHandler(storage));
  router.put("/api/v1/runs/:id/triage/:feature/:spec/actual-cause", createPutActualCauseHandler(storage));
  router.delete("/api/v1/runs/:id/triage/:feature/:spec/actual-cause", createDeleteActualCauseHandler(storage));
  router.put("/api/v1/runs/:id/triage/actual-causes", createImportActualCausesHandler(storage));

  // One hub manages many projects; secrets are scoped project/profile, so the
  // project is a required path segment (unlike runs' optional ?project= filter).
  router.get("/api/v1/projects", createListProjectsHandler(storage));
  router.get("/api/v1/projects/:project/profiles", createListProfilesHandler(storage));

  const sessionConfig = { store: storage.sessions, encryptionKey: config.encryptionKey };
  router.put("/api/v1/projects/:project/sessions/:profile/:name", createPutSessionHandler(sessionConfig));
  router.get("/api/v1/projects/:project/sessions/:profile", createListSessionsHandler(sessionConfig));
  router.get("/api/v1/projects/:project/sessions/:profile/:name", createGetSessionHandler(sessionConfig));
  router.delete("/api/v1/projects/:project/sessions/:profile/:name", createDeleteSessionHandler(sessionConfig));

  const variableConfig = { store: storage.variables, encryptionKey: config.encryptionKey };
  router.put("/api/v1/projects/:project/variables/:profile/:name", createPutVariableHandler(variableConfig));
  router.get("/api/v1/projects/:project/variables/:profile", createListVariablesHandler(variableConfig));
  router.delete("/api/v1/projects/:project/variables/:profile/:name", createDeleteVariableHandler(variableConfig));

  // Prompts are project-scoped (not per-profile) plain text, no encryption key.
  const promptConfig = { store: storage.prompts };
  router.put("/api/v1/projects/:project/prompts/:name", createPutPromptHandler(promptConfig));
  router.get("/api/v1/projects/:project/prompts", createListPromptsHandler(promptConfig));
  router.get("/api/v1/projects/:project/prompts/:name", createGetPromptHandler(promptConfig));
  router.delete("/api/v1/projects/:project/prompts/:name", createDeletePromptHandler(promptConfig));

  // Perspectives: one coverage-inventory document per project, hub-only
  // (the consuming repo keeps no local copy). JSON in, JSON out.
  const perspectivesConfig = { store: storage.perspectives };
  router.put("/api/v1/projects/:project/perspectives", createPutPerspectivesHandler(perspectivesConfig));
  router.get("/api/v1/projects/:project/perspectives", createGetPerspectivesHandler(perspectivesConfig));
  router.patch("/api/v1/projects/:project/perspectives", createPatchPerspectivesNoteHandler(perspectivesConfig));
  router.delete("/api/v1/projects/:project/perspectives", createDeletePerspectivesHandler(perspectivesConfig));

  // Triage-learning jobs: the UI creates one after grading, then polls it.
  router.post("/api/v1/projects/:project/learning-jobs", createCreateLearningJobHandler({ storage, queue }));
  router.get("/api/v1/projects/:project/learning-jobs", createListLearningJobsHandler(storage));
  router.get("/api/v1/projects/:project/learning-jobs/:jobId", createGetLearningJobHandler(storage));
}
