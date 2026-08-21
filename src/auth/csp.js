// Browsers apply form-action to the 302 after a login POST, so 'self' alone blocks Grok/Claude/ChatGPT callbacks.
const CSP_START = "default-src 'none'; style-src 'unsafe-inline'; form-action ";
const CSP_END = "; frame-ancestors 'none'; base-uri 'none'";

export const DEFAULT_CONTENT_SECURITY_POLICY = `${CSP_START}'self'${CSP_END}`;

function formActionOrigin(redirectUri) {
  if (!redirectUri) {
    return null;
  }

  let url;
  try {
    url = new URL(String(redirectUri));
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }

  const origin = url.origin;
  if (!origin || origin === 'null' || /[\s;,'"]/.test(origin)) {
    return null;
  }

  return origin;
}

export function contentSecurityPolicy(redirectUri) {
  const origin = formActionOrigin(redirectUri);
  const formAction = origin ? `'self' ${origin}` : "'self'";
  return `${CSP_START}${formAction}${CSP_END}`;
}
