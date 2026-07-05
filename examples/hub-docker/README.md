# ccqa hub — local Docker verification

This directory is a minimal Docker Compose setup for trying out `ccqa serve`
(the hub) locally. The hub is a control plane: it aggregates run results,
saved sessions, and variables — it does not execute tests. See
[docs/hub.md](../../docs/hub.md) for the full hub reference.

## Files in this directory

- `Dockerfile` — hub image: Node 24 + `ccqa`, running
  `ccqa serve --port 8787 --data-dir /data`.
- `compose.yaml` — `hub` service + a placeholder `demo-app` service,
  published on the host so a host-run `ccqa run` can target it directly.
- `.ccqa/features/demo/test-cases/homepage-title/spec.yaml` — a minimal
  `mode: live` spec that opens `${BASE_URL}/` and checks the page the
  `demo-app` service serves. Run in step 4 below, from this directory.

## Try it

Run every command below from this directory (`examples/hub-docker/`).

**1. Prepare the required environment variables.** Don't use real secrets —
generate throwaway ones for local verification:

```bash
export CCQA_HUB_TOKEN=$(openssl rand -hex 16)
export CCQA_HUB_ENCRYPTION_KEY=$(openssl rand -hex 32)
```

**2. Start the hub and the demo app:**

```bash
docker compose up --build
```

The hub is now on `http://localhost:8787`, and the demo app is published on
`http://localhost:3000`.

**3. Register `BASE_URL` as a hub variable**, pointing at the demo app as
seen from the host (the run happens on the host in step 4, not inside a
container, so it must use the published `localhost:3000` port rather than
the compose-internal `demo-app` hostname):

```bash
ccqa hub var set BASE_URL --value http://localhost:3000 --project demo \
  --hub-url http://localhost:8787 --hub-token "$CCQA_HUB_TOKEN"
```

**4. Run the demo spec on the host:**

```bash
CCQA_HUB_URL=http://localhost:8787 CCQA_HUB_TOKEN="$CCQA_HUB_TOKEN" \
  ccqa run demo/homepage-title --profile default --report
```

`ccqa run` fetches `BASE_URL` from the hub directly at execution time, so
`--profile default` picks up the variable registered in step 3 without any
separate restore step. This is a normal local `ccqa run --report` — no
upload, no remote execution.

> The demo spec is `mode: live`, so the run happens on the host and drives
> the browser with Claude — it needs Claude credentials there (`claude login`
> or `ANTHROPIC_API_KEY`). This is a property of the spec, not the hub: the
> hub itself never runs anything and needs no Claude access.

**5. Push the finished report to the hub:**

```bash
ccqa hub push --project demo \
  --hub-url http://localhost:8787 --hub-token "$CCQA_HUB_TOKEN"
```

Browse the result at `http://localhost:8787` (the hub's bundled UI) —
`report.html`'s evidence images are embedded, so the report is viewable
standalone.
