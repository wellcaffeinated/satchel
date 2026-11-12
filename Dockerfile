# Satchel server image. glibc base (not Alpine): onnxruntime-node ships glibc binaries.
FROM node:24-bookworm-slim

ARG PNPM_VERSION=11.5.2

# git: the server shells out to it for the data repository.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
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

COPY src ./src

# The embedding model is NOT baked in: it downloads into /data/models on first run.
RUN mkdir /data && chown node:node /data

ENV NODE_ENV=production \
    SATCHEL_HOST=0.0.0.0 \
    SATCHEL_PORT=8787 \
    SATCHEL_DATA=/data

USER node
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.SATCHEL_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "--experimental-strip-types", "src/main.ts"]
