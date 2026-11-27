import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Client as ClientType } from '@modelcontextprotocol/client';

// The results store is chosen when paths.ts loads, so point it at a scratch folder before importing
// the server.
const results = mkdtempSync(join(tmpdir(), 'witness-tools-'));
process.env.WITNESS_RESULTS_DIR = results;

const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const { demo } = await import('./helpers/app.js');
const { buildServer } = await import('../src/mcp/server.js');
const { Created, cleanupFor } = await import('../src/mcp/created.js');
const { getSession } = await import('../src/mcp/session.js');
const { ToolError } = await import('../src/errors.js');

// oxlint-disable-next-line typescript/no-explicit-any -- assertions read deep into each tool's own data
type ToolData = any;
type Envelope = {
  ok: boolean;
  code?: string;
  message?: string;
  data?: ToolData;
  notices?: string[];
  page?: unknown;
};

let client: ClientType;
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Envelope> => {
  const res = (await client.callTool({ name, arguments: args })) as {
    structuredContent?: Envelope;
  };
  return res.structuredContent!;
};

before(async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(serverSide);
  client = new Client({ name: 'tools-test', version: '0.0.0' });
  await client.connect(clientSide);
});

after(async () => {
  if (getSession()) await call('session_end');
  await client.close();
  rmSync(results, { recursive: true, force: true });
});

describe('created register', () => {
  it('keeps records in place, forgets them and lists pending kinds in cleanup order', () => {
    const c = new Created();
    const product = c.track('product', { id: '1', title: 'Copy of x' }) as { title: string };
    product.title = 'renamed';
    c.track('order', { reference: 'R1', product: 'renamed' });
    assert.equal(
      (c.find('product', p => (p as { id: string }).id === '1') as { title: string }).title,
      'renamed',
    );
    assert.deepEqual(
      c.pending().map(p => p.kind),
      ['order', 'product'],
    );
    for (const o of c.list('order')) c.forget('order', o);
    assert.deepEqual(
      c.pending().map(p => [p.kind, p.count]),
      [['product', 1]],
    );
  });

  it("refuses with the tool's own error when nothing matches", () => {
    const c = new Created();
    assert.throws(
      () =>
        c.require(
          'product',
          () => false,
          () => new ToolError('NOT_OWNED', 'no'),
        ),
      (e: unknown) => e instanceof ToolError && e.code === 'NOT_OWNED',
    );
  });

  it('orders each kind once, after what it waits for', () => {
    const kinds = demo.cleanupOrder.map(c => c.kind);
    for (const c of demo.cleanupOrder)
      for (const k of c.after)
        assert.ok(kinds.indexOf(k) < kinds.indexOf(c.kind), `${k} runs before ${c.kind}`);
    assert.equal(new Set(kinds).size, kinds.length);
    assert.ok(kinds.indexOf('order') < kinds.indexOf('product'));
  });
});

describe('tool catalogue', () => {
  it('has a cleanup tool and a registered cleanup for every kind', async () => {
    const names = new Set((await client.listTools()).tools.map(t => t.name));
    for (const c of demo.cleanupOrder) {
      assert.ok(names.has(c.tool), `${c.tool} is a tool`);
      assert.ok(cleanupFor(c.kind), `${c.kind} has a registered cleanup`);
    }
    assert.ok(names.has('cleanup_all'));
  });
});

describe('tool calls without a browser', () => {
  it('answers with a coded envelope when no session is open', async () => {
    const r = await call('cleanup_all');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NO_SESSION');
  });

  it('refuses an order this session did not place, before touching any page', async () => {
    await call('session_start', { ticket: 'TOOL-catalogue', kind: 'tool', env: 'staging' });
    const r = await call('order_cancel', { reference: 'NOTMINE1' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NOT_OWNED');
  });

  it('cleans nothing when nothing was made', async () => {
    const r = await call('cleanup_all');
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, { results: {}, left: [] });
  });

  it('reports each cleanup that cannot run, keeps going and says what is left', async () => {
    const created = getSession()!.created;
    created.track('order', { reference: 'R1', product: 'x' });
    created.track('coupon', { code: 'SPRING10' });
    const r = await call('cleanup_all');
    assert.equal(r.ok, true);
    assert.equal(r.data.results.orders_cleanup.error, 'NOT_LOGGED_IN');
    assert.equal(r.data.results.coupons_cleanup.error, 'NOT_LOGGED_IN');
    assert.deepEqual(r.data.left, [
      { tool: 'orders_cleanup', count: 1 },
      { tool: 'coupons_cleanup', count: 1 },
    ]);
  });

  it('skips a cleanup while what depends on it is still there', async () => {
    const created = getSession()!.created;
    created.track('product', { id: 'P1', title: 'x' });
    const r = await call('cleanup_all');
    assert.equal(r.data.results.orders_cleanup.error, 'NOT_LOGGED_IN');
    assert.deepEqual(r.data.results.products_cleanup, { skipped: 'waits for orders_cleanup' });
    assert.equal(r.data.left.length, 3);
    created.forget(
      'product',
      created.find('product', p => (p as { id: string }).id === 'P1')!,
    );
  });

  it('warns at session_end about what was not cleaned up', async () => {
    const r = await call('session_end');
    assert.equal(r.ok, true);
    assert.equal(r.data.leftBehind.length, 2);
    assert.ok(r.notices?.some(n => n.startsWith('Not cleaned up: 1 for orders_cleanup')));
  });
});
