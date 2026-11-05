#!/usr/bin/env bash
# Creates .env for trying SalmanPlex on this computer, with freshly generated secrets.
#
#   ./setup-local.sh              # image tag of the checked-out branch (or "latest")
#   ./setup-local.sh <image-tag>  # e.g. latest, claude-charming-noether-lhy664 or sha-1a2b3c4
#
# Then: ./deploy.sh   and open http://localhost:3001
# Needs Docker with Compose and openssl. For a real server, edit .env afterwards
# (see the comments in it): this sets plain-HTTP, test-friendly values.
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then
  echo "Keeping the existing $(pwd)/.env (to start over: docker compose down -v && rm .env)."
  exit 0
fi

# tr: drop Windows line endings, in case git checked the files out with CRLF.
tr -d '\r' < .env.example > .env
chmod 600 .env

# Sets NAME=VALUE in .env (replaces an existing line, or appends one). Works with GNU and BSD sed.
setval() {
  if grep -qE "^$1=" .env; then
    sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

# Published images are tagged with the branch name (with / replaced by -); main/master is "latest".
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
case "$branch" in
  ""|HEAD|main|master) default_tag=latest ;;
  *) default_tag=$(printf '%s' "$branch" | tr '/' '-') ;;
esac
TAG="${1:-$default_tag}"
setval IMAGE_TAG "$TAG"
setval POSTGRES_PASSWORD "$(openssl rand -hex 16)"
setval JWT_SECRET "$(openssl rand -hex 48)"
setval HTTPS_ONLY false
mkdir -p media

echo "Created $(pwd)/.env (image tag: $TAG)."
echo "Next: ./deploy.sh   (or BUILD=1 ./deploy.sh to build on this computer, no login needed)"
echo "Then open http://localhost:3001"
echo "The first account you create becomes the administrator. Put media files in $(pwd)/media."
