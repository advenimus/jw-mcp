FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

RUN addgroup -g 1001 -S appuser && \
    adduser -S appuser -u 1001 -G appuser && \
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
