# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-alpine
# ffmpeg provides ffprobe (metadata) and ffmpeg (HLS transcoding, thumbnails).
# tini reaps ffmpeg children and forwards signals for graceful shutdown.
RUN apk add --no-cache ffmpeg tini \
  && addgroup -S -g 1001 salmanplex \
  && adduser -S -u 1001 -G salmanplex salmanplex \
  && mkdir -p /media /cache \
  && chown salmanplex:salmanplex /media /cache

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    MEDIA_ROOT=/media \
    CACHE_DIR=/cache

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

USER salmanplex
EXPOSE 3000
VOLUME ["/media", "/cache"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
