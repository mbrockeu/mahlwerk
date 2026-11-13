# syntax=docker/dockerfile:1

# --- Stage 1: build the web interface (Vite writes to ../web/dist) ---
FROM node:22 AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- Stage 2: runtime ---
FROM python:3.13-slim

# 1 installs the optional label reader (RapidOCR, about 200 MB more)
ARG WITH_LABEL=0
# 1 installs the optional Cookidoo connector (cookidoo-api and its dependencies)
ARG WITH_COOKIDOO=0

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MAHLWERK_DB=/data/mahlwerk.db \
    MAHLWERK_WEB_DIR=/app/web

WORKDIR /app
COPY pyproject.toml README.md LICENSE ./
COPY src/ ./src/
RUN extras="" \
    && if [ "$WITH_LABEL" = "1" ]; then extras="label"; fi \
    && if [ "$WITH_COOKIDOO" = "1" ]; then extras="${extras:+$extras,}cookidoo"; fi \
    && if [ -n "$extras" ]; then pip install ".[$extras]"; else pip install .; fi \
    && rm -rf /app/src /app/pyproject.toml

COPY --from=frontend /build/web/dist /app/web

# Everything writable (database, its key file for stored credentials, catalogue files next to it, label debug copies) lives under /data.
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin mahlwerk \
    && mkdir /data && chown mahlwerk:mahlwerk /data
USER mahlwerk
VOLUME /data

EXPOSE 8110

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8110/healthz', timeout=4).status == 200 else 1)"]

CMD ["uvicorn", "mahlwerk.main:app", "--factory", "--host", "0.0.0.0", "--port", "8110", "--no-server-header"]
