# Control plane only. Slot guests still run on the host Docker engine.
FROM node:22-bookworm-slim AS web
WORKDIR /web
RUN corepack enable && corepack prepare pnpm@10.18.2 --activate
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates iptables iproute2 python3 python3-pip \
  && pip3 install --no-cache-dir --break-system-packages curl_cffi \
  && rm -rf /var/lib/apt/lists/*
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/vm2api
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY --from=web /web/dist ./web/dist
COPY scripts/docker-entrypoint.sh /usr/local/bin/vm2api-entrypoint
RUN chmod +x /usr/local/bin/vm2api-entrypoint \
  && mkdir -p /opt/vm2api/vms /opt/vm2api/data /opt/vm2api/bin
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    KIN_PROJECT_ROOT=/opt/vm2api \
    KIN_DATA_DIR=/opt/vm2api/data \
    KIN_KERNEL_BIN=/opt/vm2api/bin/kin-kernel \
    KIN_EGRESS_BIN=/opt/vm2api/bin/kin-egress \
    KIN_WORKER_BIN=/opt/vm2api/bin/kin-worker
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/vm2api-entrypoint"]
