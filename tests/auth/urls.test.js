import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeResourceUrl, mcpResourceUrl, originUrl } from '../../src/auth/urls.js';

describe('auth URL helpers', () => {
  it('strips trailing slashes from resource URLs', () => {
    assert.equal(
      canonicalizeResourceUrl('https://mcp.example.com/mcp/'),
      'https://mcp.example.com/mcp'
    );
  });

  it('uses /mcp when MCP_BASE_URL is an origin', () => {
    assert.equal(mcpResourceUrl('https://jw-mcp.example.com').href, 'https://jw-mcp.example.com/mcp');
    assert.equal(originUrl('https://jw-mcp.example.com/unused').href, 'https://jw-mcp.example.com/');
  });

  it('keeps an explicit /mcp path', () => {
    assert.equal(
      mcpResourceUrl('https://jw-mcp.example.com/mcp').href,
      'https://jw-mcp.example.com/mcp'
    );
  });
});
