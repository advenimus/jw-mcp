FROM node:22-alpine

RUN addgroup -g 1001 -S appuser && \
    adduser -S appuser -u 1001 -G appuser

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/

USER appuser

ENV NODE_ENV=production
ENV MCP_TRANSPORT=http
ENV MCP_PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["node", "src/index.js"]
