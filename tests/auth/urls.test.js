import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeResourceUrl,
  connectorPortWarning,
  isLoopbackHostname,
  mcpResourceUrl,
  originUrl,
} from '../../src/auth/urls.js';

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

describe('connectorPortWarning', () => {
  it('warns when a public HTTPS URL uses a port other than 443', () => {
    const warning = connectorPortWarning('https://jw-mcp.example.com:18443');
    assert.match(warning, /18443/);
    assert.match(warning, /443/);
    assert.match(warning, /Claude/);
  });

  it('stays quiet on the default HTTPS port', () => {
    assert.equal(connectorPortWarning('https://jw-mcp.example.com'), null);
    assert.equal(connectorPortWarning('https://jw-mcp.example.com:443/mcp'), null);
  });

  it('stays quiet for plain HTTP, which is loopback-only', () => {
    assert.equal(connectorPortWarning('http://localhost:8080'), null);
  });

  it('stays quiet for HTTPS on each loopback host', () => {
    assert.equal(connectorPortWarning('https://localhost:8443'), null);
    assert.equal(connectorPortWarning('https://127.0.0.1:8443'), null);
    assert.equal(connectorPortWarning('https://[::1]:8443'), null);
  });
});

describe('isLoopbackHostname', () => {
  it('accepts loopback names with or without IPv6 brackets', () => {
    assert.equal(isLoopbackHostname('localhost'), true);
    assert.equal(isLoopbackHostname('LOCALHOST'), true);
    assert.equal(isLoopbackHostname('127.0.0.1'), true);
    assert.equal(isLoopbackHostname('[::1]'), true);
    assert.equal(isLoopbackHostname('::1'), true);
  });

  it('rejects public and empty hosts', () => {
    assert.equal(isLoopbackHostname('jw-mcp.example.com'), false);
    assert.equal(isLoopbackHostname('127.0.0.2'), false);
    assert.equal(isLoopbackHostname(''), false);
    assert.equal(isLoopbackHostname(undefined), false);
  });
});
