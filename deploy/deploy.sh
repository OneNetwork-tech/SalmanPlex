#!/usr/bin/env bash
# Pulls the images published by CI and (re)starts the stack on this server,
# then waits until the app reports healthy.
#
#   ./deploy.sh                # deploys IMAGE_TAG from .env (default: latest)
#   ./deploy.sh sha-1a2b3c4    # deploys one specific build
#   SKIP_PULL=1 ./deploy.sh    # restart with images already on this machine
#   BUILD=1 ./deploy.sh        # build the images from this repository (no registry login needed)
#
# Private images: run `docker login ghcr.io` once with a token that has read:packages.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "Missing $(pwd)/.env: copy .env.example to .env and fill it in." >&2
  exit 1
fi

# Reads NAME from .env without sourcing it (values may contain shell characters).
envval() {
  local v
  v=$(grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | tr -d '"\r' || true)
  echo "${v:-$2}"
}

if [ $# -gt 0 ]; then
  export IMAGE_TAG="$1"
fi

if ! docker info > /dev/null 2>&1; then
  echo "Docker is not running (or you don't have access to it). Start Docker Desktop, wait until it says 'running', and try again." >&2
  exit 1
fi

# Explains a failure in plain words, based on what Docker printed.
explain() {
  local log="$1"
  if grep -qiE "exit code: 137|signal: killed|cannot allocate memory|out of memory" "$log"; then
    echo "-> Docker ran out of memory. In Docker Desktop: Settings > Resources > Memory, give it at least 4 GB, then run this again." >&2
  elif grep -qiE "no space left on device" "$log"; then
    echo "-> Docker's disk is full. Free space with: docker system prune   (Docker Desktop: Settings > Resources > Disk), then run this again." >&2
  elif grep -qiE "port is already allocated|address already in use|ports are not available" "$log"; then
    echo "-> Another program already uses one of this app's ports. Stop it, or change the port in .env (HOST_PORT / WEB_PORT / API_PORT)." >&2
  elif grep -qiE "password authentication failed" "$log"; then
    echo "-> The database was created earlier with a different password. If you don't need that data: docker compose down -v, then run this again." >&2
  elif grep -qiE "temporary failure in name resolution|could not resolve|network is unreachable|TLS handshake timeout|i/o timeout|ETIMEDOUT|ENOTFOUND|Unable to load the service index" "$log"; then
    echo "-> A download failed. Check the internet connection (and any company proxy or VPN), then run this again." >&2
  fi
}
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT
echo "Deploying SalmanPlex (image tag: ${IMAGE_TAG:-$(envval IMAGE_TAG latest)})"

if [ "${BUILD:-0}" = "1" ]; then
  echo "Building the images from source (the first build takes a few minutes)"
  mem=$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)
  if [ "${mem:-0}" -gt 0 ] && [ "$mem" -lt 3500000000 ]; then
    echo "Warning: Docker has only $((mem / 1000000)) MB of memory; building may fail. Docker Desktop: Settings > Resources > Memory, 4 GB or more." >&2
  fi
  if ! docker compose build 2>&1 | tee "$LOG"; then
    echo "" >&2
    echo "Building the images failed (see above)." >&2
    explain "$LOG"
    exit 1
  fi
elif [ "${SKIP_PULL:-0}" != "1" ]; then
  if ! docker compose pull; then
    echo "" >&2
    echo "Could not download the images. Either:" >&2
    echo "  - log in once: docker login ghcr.io -u <github-username>  (password: a token with read:packages)" >&2
    echo "  - check IMAGE_TAG in .env (a branch name with / replaced by -, or latest once merged)" >&2
    echo "  - or build them on this computer instead: BUILD=1 ./deploy.sh" >&2
    exit 1
  fi
fi
if ! docker compose up -d --remove-orphans 2>&1 | tee "$LOG"; then
  echo "" >&2
  echo "Starting the app failed (see above)." >&2
  explain "$LOG"
  exit 1
fi

check() {
  for _ in $(seq 1 90); do
    if curl -fsS -o /dev/null "$1" 2>/dev/null; then
      echo "healthy: $1"
      return 0
    fi
    sleep 2
  done
  echo "NOT healthy after 3 minutes: $1" >&2
  return 1
}

failed=0
check "http://localhost:$(envval HOST_PORT 3001)/api/health" || failed=1

if [ "$failed" -ne 0 ]; then
  docker compose ps -a
  docker compose logs --tail=100 2>&1 | tee "$LOG"
  echo "" >&2
  echo "The app did not become healthy (logs above)." >&2
  explain "$LOG"
  exit 1
fi

docker image prune -f >/dev/null
docker compose ps
