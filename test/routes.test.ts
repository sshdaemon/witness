import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertGotoAllowed } from '../src/mcp/guards.js';
import { ToolError } from '../src/errors.js';

await import('./helpers/app.js');

describe('goto allowlist', () => {
  for (const route of ['/', '/products', '/products/abc-123', '/cart', '/cart?coupon=x']) {
    it(`allows ${route}`, () => assert.doesNotThrow(() => assertGotoAllowed('store', route)));
  }
  for (const route of [
    '/admin',
    '/checkout',
    '/products/abc/edit',
    '/products/',
    '/cart/pay',
    '/logout',
    '/account/delete',
  ]) {
    it(`refuses ${route}`, () =>
      assert.throws(() => assertGotoAllowed('store', route), /not an allowed/));
  }
  it('only the path is checked, so a protocol-relative URL cannot change host', () => {
    const url = assertGotoAllowed('store', '//evil.example/products');
    assert.equal(url.pathname, '/products');
  });
  it('admin routes', () => {
    assert.doesNotThrow(() => assertGotoAllowed('admin', '/orders'));
    assert.throws(() => assertGotoAllowed('admin', '/users'), /not an allowed/);
  });
  it('refuses every route of an app the allowlist does not name', () => {
    assert.throws(
      () => assertGotoAllowed('warehouse', '/'),
      (e: unknown) => e instanceof ToolError && e.code === 'ROUTE_NOT_ALLOWED',
    );
  });
});
