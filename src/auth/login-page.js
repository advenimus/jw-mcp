function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const PAGE_STYLES = `
  body { font-family: -apple-system, system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0f172a; color: #e2e8f0; }
  .card { background: #1e293b; padding: 2rem; border-radius: 12px; max-width: 400px; width: 90%; box-shadow: 0 4px 24px rgba(0,0,0,0.3); }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; color: #f8fafc; }
  p { font-size: 0.875rem; color: #94a3b8; margin: 0 0 1.5rem; }
  label { display: block; font-size: 0.875rem; margin-bottom: 0.5rem; color: #cbd5e1; }
  input[type="password"] { width: 100%; padding: 0.75rem; border: 1px solid #334155; border-radius: 8px; background: #0f172a; color: #f8fafc; font-size: 1rem; box-sizing: border-box; }
  input[type="password"]:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.2); }
  button { width: 100%; padding: 0.75rem; background: #3b82f6; color: white; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; margin-top: 1rem; }
  button:hover { background: #2563eb; }
  .client-info { font-size: 0.75rem; color: #64748b; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #334155; }
  .error h1 { color: #f87171; }
`;

export function renderLoginPage({ pendingId, clientName, redirectHostname }) {
  const name = escapeHtml(clientName || 'Unknown client');
  const host = redirectHostname ? escapeHtml(redirectHostname) : '';
  const redirectLine = host
    ? `<div class="client-info">Redirect: ${host}</div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head>
  <title>JW MCP - Authorize</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <div class="card">
    <h1>JW MCP Server</h1>
    <p>Enter the server access key to authorize this connection.</p>
    <form method="POST" action="/authorize/callback">
      <input type="hidden" name="pending_id" value="${escapeHtml(pendingId)}">
      <label for="secret">Access Key</label>
      <input type="password" id="secret" name="secret" placeholder="Enter access key" required autofocus>
      <button type="submit">Authorize</button>
    </form>
    <div class="client-info">Client: ${name}</div>
    ${redirectLine}
  </div>
</body>
</html>`;
}

export function renderDeniedPage() {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Access Denied</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <div class="card error">
    <h1>Access Denied</h1>
    <p>Invalid access key. Connection rejected.</p>
  </div>
</body>
</html>`;
}
