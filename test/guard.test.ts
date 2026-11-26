import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installHostGuard } from '../src/mcp/guards.js';

await import('./helpers/app.js');

type Handler = (route: unknown) => unknown;

// A stand-in for a Playwright context that records what the guard registers.
function stubContext() {
  const state: {
    pred?: (u: URL) => boolean;
    handler?: Handler;
    wsPred?: (u: URL) => boolean;
    wsHandler?: (ws: { close(): void }) => void;
  } = {};
  const context = {
    route: (pred: (u: URL) => boolean, handler: Handler) => Object.assign(state, { pred, handler }),
    routeWebSocket: (pred: (u: URL) => boolean, handler: (ws: { close(): void }) => void) =>
      Object.assign(state, { wsPred: pred, wsHandler: handler }),
  };
  return { context: context as never, state };
}

const decide = (
  state: ReturnType<typeof stubContext>['state'],
  url: string,
  resourceType: string,
  method: string,
) => {
  if (!state.pred!(new URL(url))) return 'not-intercepted';
  const route = {
    request: () => ({ resourceType: () => resourceType, method: () => method }),
    fallback: () => 'allow',
    abort: () => 'block',
  };
  return state.handler!(route);
};

describe('host guard', () => {
  it('local: production hosts are blocked for pages and data, GET assets still load', async () => {
    const { context, state } = stubContext();
    await installHostGuard(context, 'local');
    assert.equal(decide(state, 'https://example.test/', 'document', 'GET'), 'block');
    assert.equal(decide(state, 'https://api.store.example.test/users/me', 'fetch', 'GET'), 'block');
    assert.equal(decide(state, 'https://admin-api.example.test/x', 'xhr', 'GET'), 'block');
    assert.equal(decide(state, 'https://example.test/x', 'fetch', 'POST'), 'block');
    assert.equal(decide(state, 'https://example.test/logo.png', 'image', 'POST'), 'block');
    assert.equal(decide(state, 'https://example.test/logo.png', 'image', 'GET'), 'allow');
    assert.equal(decide(state, 'https://example.test/font.woff2', 'font', 'GET'), 'allow');
  });

  it('production admin hosts are blocked on staging', async () => {
    const { context, state } = stubContext();
    await installHostGuard(context, 'staging');
    assert.equal(decide(state, 'https://admin.example.test/', 'document', 'GET'), 'block');
    assert.equal(decide(state, 'https://admin-api.example.test/x', 'fetch', 'GET'), 'block');
    assert.equal(
      decide(state, 'https://admin.staging.example.test/', 'document', 'GET'),
      'not-intercepted',
    );
  });

  it('local: staging hosts are also outside the environment', async () => {
    const { context, state } = stubContext();
    await installHostGuard(context, 'local');
    assert.equal(decide(state, 'https://store.staging.example.test/', 'document', 'GET'), 'block');
  });

  it('staging: staging hosts pass, production hosts are blocked', async () => {
    const { context, state } = stubContext();
    await installHostGuard(context, 'staging');
    assert.equal(
      decide(state, 'https://store.staging.example.test/', 'document', 'GET'),
      'not-intercepted',
    );
    assert.equal(decide(state, 'https://store.example.test/', 'document', 'GET'), 'block');
    assert.equal(decide(state, 'https://example.test./', 'fetch', 'GET'), 'block');
  });

  it('other hosts are left alone', async () => {
    const { context, state } = stubContext();
    await installHostGuard(context, 'local');
    assert.equal(decide(state, 'https://js.stripe.com/v3', 'script', 'GET'), 'not-intercepted');
    assert.equal(
      decide(state, 'https://store.localhost:8443/', 'document', 'GET'),
      'not-intercepted',
    );
  });

  it('websockets to outside hosts are closed', async () => {
    const { context, state } = stubContext();
    await installHostGuard(context, 'local');
    let closed = false;
    assert.equal(state.wsPred!(new URL('wss://api.example.test/socket')), true);
    assert.equal(state.wsPred!(new URL('wss://store.localhost:8443/_next/webpack-hmr')), false);
    state.wsHandler!({ close: () => (closed = true) });
    assert.equal(closed, true);
  });
});
