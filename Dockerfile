# syntax=docker/dockerfile:1

# Mahlwerk, main image: the TypeScript server (ts/) on Node 22. The Python server and the command-line tools
# (catalogue import, Yazio) are in Dockerfile.python, started through the "tools" service of docker-compose.yml.

# --- Stage 1: build the web interface (Vite writes to ../web/dist) ---
FROM node:22 AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- Stage 2: runtime (Node 22.6 or newer is needed: built-in node:sqlite, TypeScript sources run directly) ---
FROM node:22-slim

ENV NODE_ENV=production \
    MAHLWERK_DB=/data/mahlwerk.db \
    MAHLWERK_WEB_DIR=/app/web \
    MAHLWERK_HOST=0.0.0.0 \
    MAHLWERK_PORT=8110

WORKDIR /app/ts
COPY ts/package.json ts/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY ts/core ./core
COPY ts/server ./server

COPY --from=frontend /build/web/dist /app/web

# Everything writable (database, its key file for stored credentials, catalogue files and pictures next to it) lives under /data.
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin mahlwerk \
    && mkdir /data && chown mahlwerk:mahlwerk /data
USER mahlwerk
VOLUME /data

EXPOSE 8110

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.MAHLWERK_PORT||8110)+'/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "server/main.ts"]
