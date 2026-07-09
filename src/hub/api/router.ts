import type { IncomingMessage, ServerResponse } from "node:http";

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  url: URL;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

/**
 * A minimal hand-written router: no dependency, just enough to dispatch the
 * hub's small, flat REST surface (docs/hub-api.md). Routes are matched in
 * registration order; `:name` segments capture into `ctx.params`, and a
 * trailing `*rest` segment (used for `/artifacts/*path`) captures everything
 * remaining, slashes included.
 */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    const patternSrc = path
      .split("/")
      .map((segment) => {
        if (segment.startsWith("*")) {
          paramNames.push(segment.slice(1));
          return "(.*)";
        }
        if (segment.startsWith(":")) {
          paramNames.push(segment.slice(1));
          return "([^/]+)";
        }
        return segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    this.routes.push({ method, pattern: new RegExp(`^${patternSrc}$`), paramNames, handler });
  }

  get(path: string, handler: RouteHandler): void {
    this.add("GET", path, handler);
  }
  post(path: string, handler: RouteHandler): void {
    this.add("POST", path, handler);
  }
  put(path: string, handler: RouteHandler): void {
    this.add("PUT", path, handler);
  }
  patch(path: string, handler: RouteHandler): void {
    this.add("PATCH", path, handler);
  }
  delete(path: string, handler: RouteHandler): void {
    this.add("DELETE", path, handler);
  }

  /** Returns the matched handler + params, or null when no route matches (caller sends 404). */
  match(method: string, pathname: string): { handler: RouteHandler; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      try {
        route.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(m[i + 1] ?? "");
        });
      } catch {
        // Malformed percent-encoding (e.g. "%ff") throws URIError. Treat the
        // path as unroutable (404) instead of letting the throw escape — this
        // runs before auth, so an escaping error would be an unauthenticated
        // crash vector.
        continue;
      }
      return { handler: route.handler, params };
    }
    return null;
  }
}
