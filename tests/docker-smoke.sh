#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="$(mktemp)"
cleanup() {
  docker compose --env-file "$ENV_FILE" down --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ENV_FILE"
}
trap cleanup EXIT

cat > "$ENV_FILE" <<'EOF'
MCP_BASE_URL=http://localhost:8080
MCP_AUTH_SECRET=test-secret-value
MCP_AUTH=true
MCP_PORT=8080
EOF

docker compose --env-file "$ENV_FILE" down --remove-orphans >/dev/null 2>&1 || true
docker compose --env-file "$ENV_FILE" up --build -d

for _ in $(seq 1 40); do
  if curl -sf http://localhost:8080/health >/dev/null; then
    break
  fi
  sleep 1
done

curl -sf http://localhost:8080/health >/dev/null

MCP_BASE_URL=http://localhost:8080 \
MCP_AUTH_SECRET=test-secret-value \
  node tests/docker-handshake.js

echo "Docker smoke passed"
