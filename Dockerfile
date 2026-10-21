# Control plane. Only source is in git: the console and Go helpers build here, and the
# prebuilt slot payloads come from the release pinned in deploy/payload.json.

ARG BUILDPLATFORM=linux/amd64
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS web
RUN npm install -g pnpm@10
WORKDIR /src/web
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM --platform=$BUILDPLATFORM golang:1.25-bookworm AS helpers
ENV CGO_ENABLED=0 GOOS=linux GOARCH=amd64
WORKDIR /src
COPY worker/go.mod worker/go.sum ./worker/
RUN cd worker && go mod download
COPY worker/ ./worker/
COPY api-kernel/go.mod api-kernel/go.sum ./api-kernel/
RUN cd api-kernel && go mod download
COPY api-kernel/ ./api-kernel/
RUN cd worker && go build -buildvcs=false -trimpath -o /out/kin-worker ./cmd/kin-worker \
  && go build -buildvcs=false -trimpath -o /out/kin-egress ./cmd/kin-egress \
  && CGO_ENABLED=0 go build -buildvcs=false -trimpath -o /out/kin-slot-gate ./cmd/kin-slot-gate \
  && cd ../api-kernel && go build -buildvcs=false -trimpath -o /out/kin-api-kernel ./cmd/kin-api-kernel

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS payload
WORKDIR /src
COPY deploy/payload.json deploy/payload.json
COPY scripts/fetch-payload.mjs scripts/fetch-payload.mjs
RUN node scripts/fetch-payload.mjs --dest /payload

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates iptables iproute2 python3 \
  && rm -rf /var/lib/apt/lists/*
# Debian Bookworm defaults to PG15; backups require the PG17 client.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl --fail --silent --show-error -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-17 \
    && pg_dump --version | grep -E ' 17\.' \
    && pg_restore --version | grep -E ' 17\.' \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/vm2api
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY VERSION CHANGELOG.md ./
COPY docker/kin-os ./docker/kin-os
COPY docker/kin-kvm ./docker/kin-kvm
COPY --from=web /src/web/dist ./web/dist
COPY --from=payload /payload/bin/ /opt/vm2api/image-bin/
COPY --from=helpers /out/ /opt/vm2api/image-bin/
COPY share/wrap-cli /opt/vm2api/image-wrap-cli
COPY --from=payload /payload/share/wrap-cli/ /opt/vm2api/image-wrap-cli/
COPY --from=payload /payload/share/crag/ /opt/vm2api/image-crag/
COPY scripts/docker-entrypoint.sh /usr/local/bin/vm2api-entrypoint
RUN chmod 755 /usr/local/bin/vm2api-entrypoint /opt/vm2api/image-bin/* \
  && rm -f /opt/vm2api/src/lib/oauth/auth.js \
  && cp -a /opt/vm2api/src/config /opt/vm2api/image-config \
  && mkdir -p /opt/vm2api/vms /opt/vm2api/data /opt/vm2api/bin /opt/vm2api/share
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    KIN_PROJECT_ROOT=/opt/vm2api \
    KIN_DATA_DIR=/opt/vm2api/data \
    KIN_KERNEL_BIN=/opt/vm2api/bin/kin-kernel \
    KIN_EGRESS_BIN=/opt/vm2api/bin/kin-egress \
    KIN_WORKER_BIN=/opt/vm2api/bin/kin-worker \
    KIN_CODEX_KERNEL_BIN=/opt/vm2api/bin/kin-codex-kernel \
    KIN_OAUTH_AUTH_BIN=/opt/vm2api/bin/kin-oauth-auth \
    KIN_COMPUTER_BIN=/opt/vm2api/bin/kin-computer \
    KIN_API_KERNEL_BIN=/opt/vm2api/bin/kin-api-kernel
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/vm2api-entrypoint"]
