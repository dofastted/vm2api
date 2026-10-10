#!/bin/sh
set -eu

ROOT=$1
PROJECT=$2
CONTAINER=$3
PREVIOUS_ID=$4
TAG=$5
ARCH=$6
shift 6
cd "$ROOT"

COMPOSE_FILE_LIST=''
for file do
  if [ -n "$COMPOSE_FILE_LIST" ]; then COMPOSE_FILE_LIST="$COMPOSE_FILE_LIST:"; fi
  COMPOSE_FILE_LIST="$COMPOSE_FILE_LIST$file"
done

compose() {
  COMPOSE_FILE="$COMPOSE_FILE_LIST" docker compose \
    --project-directory "$ROOT" --project-name "$PROJECT" "$@"
}

# Use the HTTP server's kernel client, so this also catches auth/protocol regressions.
# Busy kernels may have no idle slots; process health still has to survive the update.
probe() {
  docker exec "$CONTAINER" node --input-type=module -e '
    const [mode, target, baseline = "[]"] = process.argv.slice(1)
    const port = process.env.PORT || "8787"
    const base = `http://127.0.0.1:${port}`
    const key = process.env.KIN_API_KEY || process.env.VM2API_API_KEY || ""
    async function json(path) {
      const res = await fetch(`${base}${path}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(12000),
      })
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
      const body = await res.json()
      return body.data || body
    }
    function kernelHealthy(detail) {
      const kernel = detail.kernel
      const health = kernel?.codex_health || kernel?.rust_health || kernel?.go_health
      return health?.status === 200 && health.process_up !== false && health.healthy !== false
    }
    try {
      if (mode === "snapshot") {
        const vms = await json("/api/panel/vms")
        if (!Array.isArray(vms)) throw new Error("Invalid slot list")
        const healthy = []
        for (const vm of vms.filter(vm => vm.status === "running")) {
          if (kernelHealthy(await json(`/api/panel/vms/${encodeURIComponent(vm.id)}`))) {
            healthy.push(vm.id)
          }
        }
        console.log(JSON.stringify(healthy))
      } else {
        const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) })
        if (!health.ok) throw new Error(`Backend health: HTTP ${health.status}`)
        const version = await json("/api/panel/version")
        if (version.current_tag !== target) throw new Error(`Backend still at ${version.current_tag}`)
        for (const id of JSON.parse(baseline)) {
          if (!kernelHealthy(await json(`/api/panel/vms/${encodeURIComponent(id)}`))) {
            throw new Error(`Previously healthy slot ${id} failed kernel verification`)
          }
        }
      }
    } catch (error) {
      console.error(error.message)
      process.exit(1)
    }
  ' "$@"
}

# Let the update request return before replacing its own HTTP server.
sleep 2
BASELINE=$(probe snapshot "$TAG")
echo "Recording healthy slot kernels before upgrade: $BASELINE"
if [ -d .git ]; then
  if [ "$ARCH" = arm64 ]; then
    case ":$COMPOSE_FILE_LIST:" in
      *":$ROOT/docker-compose.arm64.yml:"*) ;;
      *) echo 'ARM64 source install lacks docker-compose.arm64.yml' >&2; exit 1 ;;
    esac
  fi
  export GIT_TERMINAL_PROMPT=0
  command -v git >/dev/null || apk add --no-cache git >/dev/null
  git config --global --add safe.directory "$ROOT"
  git fetch --tags origin
  # Routing and interception rules are tracked defaults but live operator config.
  CONFIG_BACKUP=$(mktemp -d)
  if [ -d src/config ]; then cp -a src/config "$CONFIG_BACKUP/config"; fi
  restore_config() {
    if [ -d "$CONFIG_BACKUP/config" ]; then
      mkdir -p src/config
      cp -a "$CONFIG_BACKUP/config/." src/config/
    fi
    rm -rf "$CONFIG_BACKUP"
  }
  if ! git checkout -f --detach "$TAG"; then
    restore_config
    exit 1
  fi
  restore_config
  chmod 755 bin/kin-* 2>/dev/null || true
  grep -q '^!CHANGELOG.md$' .dockerignore 2>/dev/null || printf '\n!CHANGELOG.md\n' >> .dockerignore
  if [ "$ARCH" = amd64 ]; then
    COMPOSE_FILE_LIST="$COMPOSE_FILE_LIST:$ROOT/docker-compose.build.yml"
  fi
  compose build vm2api
else
  IMAGE_TAG=$TAG
  [ "$ARCH" != arm64 ] || IMAGE_TAG=$TAG-arm64
  touch .env
  if grep -q '^VM2API_IMAGE_TAG=' .env; then
    sed -i.bak "s|^VM2API_IMAGE_TAG=.*|VM2API_IMAGE_TAG=$IMAGE_TAG|" .env
    rm -f .env.bak
  else
    printf '\nVM2API_IMAGE_TAG=%s\n' "$IMAGE_TAG" >> .env
  fi
  compose pull vm2api
fi

compose up -d --no-deps --force-recreate vm2api
CURRENT_ID=$(docker inspect --format '{{.Id}}' "$CONTAINER")
if [ "$CURRENT_ID" = "$PREVIOUS_ID" ]; then
  echo 'Compose did not replace the running control plane' >&2
  exit 1
fi

# Check the backend and previously healthy slots, rather than trusting VERSION.
attempt=0
while [ "$attempt" -lt 45 ]; do
  if probe verify "$TAG" "$BASELINE"; then
    [ -d .git ] || printf '%s\n' "${TAG#v}" > VERSION
    echo "Control plane restarted and verified at $TAG"
    echo "Previously healthy slot kernels verified: $BASELINE"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 2
done
echo "Control plane or previously healthy slot kernels did not become healthy at $TAG" >&2
exit 1
