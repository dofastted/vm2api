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

# Let the update request return before replacing its own HTTP server.
sleep 2
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
  git checkout -f --detach "$TAG"
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

# Check the backend over HTTP, rather than trusting VERSION in the checkout.
attempt=0
while [ "$attempt" -lt 45 ]; do
  if docker exec "$CONTAINER" node --input-type=module -e '
    const port = process.env.PORT || "8787"
    const base = `http://127.0.0.1:${port}`
    const key = process.env.KIN_API_KEY || process.env.VM2API_API_KEY || ""
    try {
      const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) })
      if (!health.ok) process.exit(1)
      const res = await fetch(`${base}/api/panel/version`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(12000),
      })
      const body = await res.json()
      const status = body.data || body
      if (!res.ok || status.current_tag !== process.argv[1]) process.exit(1)
    } catch { process.exit(1) }
  ' "$TAG"; then
    [ -d .git ] || printf '%s\n' "${TAG#v}" > VERSION
    echo "Control plane restarted and verified at $TAG"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 2
done
echo "Control plane did not become healthy at $TAG" >&2
exit 1
