# ccqa hub (`ccqa serve`) built from the current source tree — not the npm
# release — so a checkout (including unreleased branches) runs as-is.
# Used by ./docker-compose.yaml; see README.md "Local hub with Docker Compose".

# --- build: compile TypeScript to dist/ with tsdown -------------------------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# corepack picks the pnpm version pinned in package.json's `packageManager`.
RUN corepack enable pnpm && pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsdown.config.ts ./
COPY bin ./bin
COPY src ./src
RUN pnpm build

# --- prod-deps: production node_modules only ---------------------------------
FROM node:22-slim AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# After the install, trim payloads `ccqa serve` never executes (~285 MB):
#   - the musl variants of the claude-agent-sdk native binary — node:*-slim is
#     glibc, but pnpm installs every os/cpu-matching variant regardless of
#     libc. The glibc variant stays: hub-side triage-learning jobs run Claude
#     through it.
#   - agent-browser's per-platform browser binaries. The package itself must
#     stay (the CLI resolves its JS launcher at load time), but only
#     client-side record/run ever spawns the binaries.
RUN corepack enable pnpm && pnpm install --prod --frozen-lockfile --ignore-scripts \
  && rm -rf node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-*-musl* \
  && find node_modules/.pnpm/agent-browser@*/node_modules/agent-browser/bin \
       -type f ! -name agent-browser.js -delete

# --- runtime -----------------------------------------------------------------
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Pre-create the data dir owned by the unprivileged user so a named volume
# mounted there inherits writable ownership on first use.
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8787
ENTRYPOINT ["node", "dist/bin/ccqa.mjs"]
CMD ["serve", "--port", "8787", "--data-dir", "/data"]
