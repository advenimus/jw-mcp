import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPinnedLookup,
  fetchClientIdMetadata,
  isHttpsClientId,
  isLoopbackRedirectMatch,
} from '../../src/auth/cimd.js';
import { McpOAuthProvider } from '../../src/auth.js';
import { testClient } from '../helpers.js';

const DOCUMENT_URL = 'https://chatgpt.com/oauth/client.json';

function validDocument(overrides = {}) {
  return {
    client_id: DOCUMENT_URL,
    client_name: 'ChatGPT',
    redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    token_endpoint_auth_method: 'none',
    ...overrides,
  };
}

describe('CIMD helpers', () => {
  it('accepts HTTPS client IDs and rejects others', () => {
    assert.equal(isHttpsClientId(DOCUMENT_URL), true);
    assert.equal(isHttpsClientId('http://chatgpt.com/oauth/client.json'), false);
    assert.equal(isHttpsClientId('test-client'), false);
  });

  it('matches loopback redirects while ignoring the port', () => {
    assert.equal(
      isLoopbackRedirectMatch(
        ['http://localhost/callback', 'http://127.0.0.1/callback'],
        'http://localhost:3118/callback'
      ),
      true
    );
    assert.equal(
      isLoopbackRedirectMatch(
        ['http://127.0.0.1/callback'],
        'http://127.0.0.1:4123/callback'
      ),
      true
    );
    assert.equal(
      isLoopbackRedirectMatch(
        ['https://claude.ai/api/mcp/auth_callback'],
        'https://claude.ai/api/mcp/auth_callback'
      ),
      false
    );
  });

  it('fetches and validates a CIMD document', async () => {
    const metadata = await fetchClientIdMetadata(DOCUMENT_URL, {
      resolveFn: async () => [{ address: '1.2.3.4', family: 4 }],
      fetchFn: async () => new Response(JSON.stringify(validDocument()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });
    assert.equal(metadata.client_id, DOCUMENT_URL);
    assert.deepEqual(metadata.redirect_uris, validDocument().redirect_uris);
  });

  it('rejects a document whose client_id does not match the URL', async () => {
    await assert.rejects(
      () => fetchClientIdMetadata(DOCUMENT_URL, {
        resolveFn: async () => [{ address: '1.2.3.4', family: 4 }],
        fetchFn: async () => new Response(
          JSON.stringify(validDocument({ client_id: 'https://evil.example/client.json' })),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
      }),
      /client_id/
    );
  });

  it('blocks fetches to private IP addresses', async () => {
    await assert.rejects(
      () => fetchClientIdMetadata(DOCUMENT_URL, {
        resolveFn: async () => [{ address: '127.0.0.1', family: 4 }],
        fetchFn: async () => {
          throw new Error('fetch should not run');
        },
      }),
      /private|blocked/i
    );
  });

  it('blocks private and mapped IPv6 addresses without fetching', async () => {
    const blocked = [
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '64:ff9b::7f00:1',
      '64:ff9b::c0a8:1',
    ];

    for (const address of blocked) {
      let fetched = false;
      await assert.rejects(
        () => fetchClientIdMetadata(DOCUMENT_URL, {
          resolveFn: async () => [{ address, family: 6 }],
          fetchFn: async () => {
            fetched = true;
            throw new Error('fetch should not run');
          },
        }),
        /private|blocked/i
      );
      assert.equal(fetched, false, `fetch ran for ${address}`);
    }
  });

  it('allows public IPv4-mapped and NAT64 addresses', async () => {
    for (const address of ['::ffff:8.8.8.8', '64:ff9b::808:808']) {
      const metadata = await fetchClientIdMetadata(DOCUMENT_URL, {
        resolveFn: async () => [{ address, family: 6 }],
        fetchFn: async () => new Response(JSON.stringify(validDocument()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      });
      assert.equal(metadata.client_id, DOCUMENT_URL);
    }
  });

  it('pins connect lookup to the already-resolved addresses', () => {
    const lookup = createPinnedLookup([{ address: '1.2.3.4', family: 4 }]);
    lookup('chatgpt.com', { all: true }, (error, addresses) => {
      assert.equal(error, null);
      assert.deepEqual(addresses, [{ address: '1.2.3.4', family: 4 }]);
    });
    lookup('chatgpt.com', {}, (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, '1.2.3.4');
      assert.equal(family, 4);
    });
  });

  it('passes a dispatcher so fetch uses the pinned lookup', async () => {
    let captured;
    await fetchClientIdMetadata(DOCUMENT_URL, {
      resolveFn: async () => [{ address: '1.2.3.4', family: 4 }],
      fetchFn: async (_url, options) => {
        captured = options;
        return new Response(JSON.stringify(validDocument()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    assert.ok(captured?.dispatcher);
  });

  it('re-checks blocked addresses on redirects and does not fetch the target', async () => {
    let secondFetch = false;
    await assert.rejects(
      () => fetchClientIdMetadata(DOCUMENT_URL, {
        resolveFn: async (hostname) => {
          if (hostname === 'chatgpt.com') {
            return [{ address: '1.2.3.4', family: 4 }];
          }
          return [{ address: '127.0.0.1', family: 4 }];
        },
        fetchFn: async (url) => {
          if (new URL(url).hostname === 'chatgpt.com') {
            return new Response(null, {
              status: 302,
              headers: { location: 'https://evil.example/client.json' },
            });
          }
          secondFetch = true;
          throw new Error('fetch should not run');
        },
      }),
      /private|blocked/i
    );
    assert.equal(secondFetch, false);
  });

  it('refuses oversized Content-Length without buffering the body', async () => {
    await assert.rejects(
      () => fetchClientIdMetadata(DOCUMENT_URL, {
        resolveFn: async () => [{ address: '1.2.3.4', family: 4 }],
        fetchFn: async () => ({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': String(65 * 1024) }),
          arrayBuffer: async () => {
            throw new Error('arrayBuffer should not run');
          },
          body: {
            getReader() {
              throw new Error('body should not be read');
            },
          },
        }),
      }),
      /too large/
    );
  });

  it('aborts when the body stream exceeds the size cap', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(32).fill(1));
        controller.close();
      },
    });
    await assert.rejects(
      () => fetchClientIdMetadata(DOCUMENT_URL, {
        maxBytes: 16,
        resolveFn: async () => [{ address: '1.2.3.4', family: 4 }],
        fetchFn: async () => new Response(stream, { status: 200 }),
      }),
      /too large/
    );
  });

  it('rejects unsafe CIMD redirect_uris schemes', async () => {
    const unsafe = [
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      'http://example.com/callback',
    ];
    for (const redirect of unsafe) {
      await assert.rejects(
        () => fetchClientIdMetadata(DOCUMENT_URL, {
          resolveFn: async () => [{ address: '1.2.3.4', family: 4 }],
          fetchFn: async () => new Response(
            JSON.stringify(validDocument({ redirect_uris: [redirect] })),
            { status: 200, headers: { 'content-type': 'application/json' } }
          ),
        }),
        /redirect_uris|scheme/i
      );
    }
  });

  it('allows https and loopback http redirect_uris', async () => {
    const metadata = await fetchClientIdMetadata(DOCUMENT_URL, {
      resolveFn: async () => [{ address: '1.2.3.4', family: 4 }],
      fetchFn: async () => new Response(
        JSON.stringify(validDocument({
          redirect_uris: [
            'https://chatgpt.com/connector_platform_oauth_redirect',
            'http://localhost/callback',
            'http://127.0.0.1/callback',
          ],
        })),
        { status: 200, headers: { 'content-type': 'application/json' } }
      ),
    });
    assert.equal(metadata.redirect_uris.length, 3);
  });
});

describe('CIMD client ensure', () => {
  it('registers a CIMD client and allows a loopback port variant', async () => {
    const provider = new McpOAuthProvider({
      authSecret: 'test-secret-value',
      resourceUrl: 'http://localhost:8080/mcp',
      cimd: {
        resolveFn: async () => [{ address: '1.2.3.4', family: 4 }],
        fetchFn: async () => new Response(
          JSON.stringify(validDocument({
            redirect_uris: ['http://localhost/callback'],
          })),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
      },
    });

    const client = await provider.ensureClient(
      DOCUMENT_URL,
      'http://localhost:3118/callback'
    );
    assert.equal(client.client_id, DOCUMENT_URL);
    assert.deepEqual(client.redirect_uris, ['http://localhost/callback']);
    assert.equal(
      isLoopbackRedirectMatch(client.redirect_uris, 'http://localhost:3118/callback'),
      true
    );
  });

  it('revalidates CIMD metadata after 24 hours and replaces redirect URIs', async () => {
    let now = Date.now();
    let fetches = 0;
    const provider = new McpOAuthProvider({
      authSecret: 'test-secret-value',
      resourceUrl: 'http://localhost:8080/mcp',
      now: () => now,
      cimd: {
        resolveFn: async () => [{ address: '1.2.3.4', family: 4 }],
        fetchFn: async () => {
          fetches += 1;
          const redirect_uris = fetches === 1
            ? ['https://chatgpt.com/old', 'http://localhost:3118/callback']
            : ['https://chatgpt.com/new'];
          return new Response(
            JSON.stringify(validDocument({ redirect_uris })),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        },
      },
    });

    const first = await provider.ensureClient(DOCUMENT_URL);
    assert.equal(fetches, 1);
    assert.deepEqual(first.redirect_uris, [
      'https://chatgpt.com/old',
      'http://localhost:3118/callback',
    ]);

    const cached = await provider.ensureClient(DOCUMENT_URL);
    assert.equal(fetches, 1);
    assert.deepEqual(cached.redirect_uris, first.redirect_uris);

    now += 25 * 60 * 60 * 1000;
    const refreshed = await provider.ensureClient(DOCUMENT_URL);
    assert.equal(fetches, 2);
    assert.deepEqual(refreshed.redirect_uris, ['https://chatgpt.com/new']);
  });

  it('keeps cached CIMD metadata when a stale re-fetch fails', async () => {
    let now = Date.now();
    let fetches = 0;
    const provider = new McpOAuthProvider({
      authSecret: 'test-secret-value',
      resourceUrl: 'http://localhost:8080/mcp',
      now: () => now,
      cimd: {
        resolveFn: async () => [{ address: '1.2.3.4', family: 4 }],
        fetchFn: async () => {
          fetches += 1;
          if (fetches > 1) {
            throw new Error('CIMD unavailable');
          }
          return new Response(
            JSON.stringify(validDocument({
              redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
            })),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        },
      },
    });

    await provider.ensureClient(DOCUMENT_URL);
    now += 25 * 60 * 60 * 1000;
    const cached = await provider.ensureClient(
      DOCUMENT_URL,
      'http://localhost:9999/extra'
    );
    assert.equal(fetches, 2);
    assert.deepEqual(cached.redirect_uris, [
      'https://chatgpt.com/connector_platform_oauth_redirect',
    ]);
  });

  it('returns a previously registered DCR client without fetching', async () => {
    const provider = new McpOAuthProvider({
      authSecret: 'test-secret-value',
      resourceUrl: 'http://localhost:8080/mcp',
      cimd: {
        fetchFn: async () => {
          throw new Error('should not fetch');
        },
      },
    });
    const existing = testClient();
    await provider.clientsStore.registerClient(existing);
    const client = await provider.ensureClient(existing.client_id, existing.redirect_uris[0]);
    assert.equal(client.client_id, existing.client_id);
  });
});
