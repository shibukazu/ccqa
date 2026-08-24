# 0025. Source maps for a deployed commit live on the hub

- Status: accepted
- Date: 2026-08-24

## Context and problem statement

The browser half of coverage (ADR-0021) reports what ran as byte ranges in
whatever the bundler emitted. Turning those back into repository paths needs
the build's source maps, which ccqa reads from the application under test: the
script says where its map is, and the run fetches it through the browser so
the page's credentials come along.

That fails whenever the deployment does not serve its maps — and not serving
them is the normal choice, because a map carries the original source. One
deployment observed in practice deletes them in the same CI step that uploads
the assets:

```sh
find .next/static -name "*.map" -exec rm -f {} +
aws s3 sync ./.next/static "${prefix}/_next/static"
```

The measurement then reports every frontend file as unreached. Not as an
error: the run is green, the row simply names server files only, and the
selection built on it (ADR-0024) answers `notNeeded` for a spec whose whole
subject is a screen. A measured 194 files, of which 2 were frontend, looked
exactly like a spec that never opened the page.

The maps exist — the build produced them and threw them away. The problem is
that the only place ccqa knows to look is the one place they are deliberately
absent.

## Considered options

- **Serve the maps.** Allow `.map` through the CDN, optionally behind a header
  or IP restriction. Nothing to build; the deployment decides how far to open
  it.
- **Inline them into the bundle.** No fetch at all. But the bundle grows by
  roughly the size of the source, on an environment whose value depends on
  resembling production, and Next.js 16 has no setting for it under Turbopack
  — it would take a post-build rewrite of every chunk.
- **Push them to the hub at deploy time, read them at run time.** The maps
  never reach the CDN; the deployment keeps its posture, and coverage gets a
  place to look that is not the application.

## Decision

The hub stores source maps for a deployed commit, keyed
`project / commit / asset path`. `ccqa hub sourcemap push` sends them from the
build output; `ccqa run --coverage` reads them for the commit the deploy log
says is running.

**Only the fields coverage reads are stored.** A map's `sourcesContent` is the
original source in full, and the reader never consults it — `prepareSourceMap`
uses `version`, `sources`, `sourceRoot` and `mappings` and nothing else.
Storing the rest would recreate on the hub exactly what the deployment refused
to publish, for data no reader opens. What the hub holds is a table of file
names and offsets.

**The commit is the key, not the profile.** A build output does not vary by
which environment runs it, the same way the drift ledger does not (ADR-0013).
Two deployments of one commit share its maps.

**Retention is by commit count, not age.** Ten commits, swept when a push
lands — the same "terminal write, not startup sweep" rule run retention uses,
for the same reason: the hub whose disk grows is the one never restarted. A
run needs the maps for what is deployed now; a few predecessors cover a run
that started just before a deploy landed.

**The page still wins.** A map the script points at describes the code that
actually ran, so it is tried first and the stored copy stands in only when
that is missing or unreadable. "Unreadable" is load-bearing: a catch-all route
answers a missing `.map` with an HTML page, which is a body but not a map, so
the fallback is decided by whether the bytes parse — not by whether something
came back.

## Consequences

The hub gains its first artifact belonging to the application rather than to
ccqa's own record-keeping. It stays a control plane: put, read, list, and no
interpretation (ADR-0006).

Asset origins are declared separately from `coverage.instrumentedOrigins`.
Recognising a script as this project's is a wider question than deciding where
a spec cookie may go, and merging them would push a deployment to widen the
cookie's reach to cover its CDN.

A deployment that never pushes changes nothing: the fallback is absent, and
coverage reports what the page allows — which is what it did before.

Pushing is a deploy-time step, so a commit deployed without it has no maps
even though it has assets. The read side treats that as "no map", the same as
a build that never made one.
