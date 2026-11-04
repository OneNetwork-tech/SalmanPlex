#!/usr/bin/env bash
# Pulls the images published by CI and (re)starts the stack on this server,
# then waits until the app reports healthy.
#
#   ./deploy.sh                # deploys IMAGE_TAG from .env (default: latest)
#   ./deploy.sh sha-1a2b3c4    # deploys one specific build
#   SKIP_PULL=1 ./deploy.sh    # restart with images already on this machine
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
  v=$(grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | tr -d '"' || true)
  echo "${v:-$2}"
}

if [ $# -gt 0 ]; then
  export IMAGE_TAG="$1"
fi
echo "Deploying SalmanPlex (image tag: ${IMAGE_TAG:-$(envval IMAGE_TAG latest)})"

if [ "${SKIP_PULL:-0}" != "1" ]; then
  docker compose pull
fi
docker compose up -d --remove-orphans

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
  docker compose ps
  docker compose logs --tail=100
  exit 1
fi

docker image prune -f >/dev/null
docker compose ps
