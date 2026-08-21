import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONTENT_SECURITY_POLICY,
  contentSecurityPolicy,
} from '../../src/auth/csp.js';

describe('contentSecurityPolicy', () => {
  it('defaults to form-action self', () => {
    assert.equal(
      DEFAULT_CONTENT_SECURITY_POLICY,
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    );
    assert.equal(contentSecurityPolicy(), DEFAULT_CONTENT_SECURITY_POLICY);
  });

  it('adds the OAuth redirect origin so browsers can follow the post-login 302', () => {
    assert.equal(
      contentSecurityPolicy('https://grok.com/auth/callback'),
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://grok.com; frame-ancestors 'none'; base-uri 'none'"
    );
  });

  it('ignores unsafe or unusable redirect URIs', () => {
    assert.equal(contentSecurityPolicy('javascript:alert(1)'), DEFAULT_CONTENT_SECURITY_POLICY);
    assert.equal(contentSecurityPolicy('not a url'), DEFAULT_CONTENT_SECURITY_POLICY);
    assert.equal(contentSecurityPolicy('data:text/html,hi'), DEFAULT_CONTENT_SECURITY_POLICY);
  });
});
