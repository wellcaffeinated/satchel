# Satchel server image. glibc base (not Alpine): onnxruntime-node ships glibc binaries.
FROM node:24-bookworm-slim

ARG PNPM_VERSION=11.5.2

# git: the server shells out to it for the data repository.
# tini: PID 1 that forwards signals and reaps the processes git leaves behind.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare "pnpm@${PNPM_VERSION}" --activate

WORKDIR /app

# pnpm-workspace.yaml carries the allowBuilds entries (onnxruntime-node) that let the
# install run its build script. Copy it with the manifests, before the source, for layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# ONNXRUNTIME_NODE_INSTALL=skip: the CPU runtime ships inside the package; the install script
# would otherwise download ~300 MB of CUDA and TensorRT libraries that this server never uses.
# The package also bundles Windows and macOS binaries, and pnpm keeps a second copy of
# everything in its store; both are removed in the same layer so they never reach the image.
RUN ONNXRUNTIME_NODE_INSTALL=skip pnpm install --frozen-lockfile --prod \
  && rm -rf "$(pnpm store path)" /root/.cache \
  && find node_modules/.pnpm -type d \( -path '*/onnxruntime-node/bin/napi-v*/win32' -o -path '*/onnxruntime-node/bin/napi-v*/darwin' \) -prune -exec rm -rf {} +

COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/satchel-entrypoint
COPY src ./src

# Two volumes, kept apart so a backup of /data holds the memories and nothing else:
#   /data    the memories (repo/ and index.sqlite). Back this up.
#   /models  the embedding model, downloaded on first run, never baked in. Safe to lose.
RUN mkdir /data /models && chown node:node /data /models

# PUID, PGID, UMASK and TZ are read at start (see docker/entrypoint.sh and docs/deploy.md).
# Any SATCHEL_* or CF_ACCESS_* variable can come from a file: NAME_FILE or FILE__NAME.
ENV NODE_ENV=production \
    SATCHEL_HOST=0.0.0.0 \
    SATCHEL_PORT=8787 \
    SATCHEL_DATA=/data \
    SATCHEL_MODELS=/models

VOLUME ["/data", "/models"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.SATCHEL_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/satchel-entrypoint"]
CMD ["node", "--experimental-strip-types", "src/main.ts"]
