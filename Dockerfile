FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

RUN groupadd --system --gid 1001 appuser && \
    useradd --system --uid 1001 --gid appuser --home /nonexistent --shell /usr/sbin/nologin appuser && \
    mkdir -p /data && \
    chown appuser:appuser /data

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src/ ./src/

USER appuser

ENV NODE_ENV=production
ENV MCP_TRANSPORT=http
ENV MCP_PORT=8080
ENV AUTH_STORE_PATH=/data/auth.json

EXPOSE 8080
VOLUME /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node --input-type=module -e "fetch('http://127.0.0.1:8080/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
