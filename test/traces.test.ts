import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { prose } from '../src/prose.js';

process.env.WITNESS_RESULTS_DIR = mkdtempSync(join(tmpdir(), 'witness-traces-'));
await import('./helpers/app.js');
const { Session, endSession, startSession } = await import('../src/mcp/session.js');
const { store } = await import('../src/mcp/store.js');

// A browser context whose trace is a small file, so the rule can be checked without a browser.
const open = (s: InstanceType<typeof Session>, key = 'buyer:store') => {
  const [actor, app] = key.split(':');
  const context = {
    tracing: {
      stop: async (o: { path?: string } = {}) => o.path && writeFileSync(o.path, 'zip'),
    },
    close: async () => {},
  };
  (s as unknown as { handles: Map<string, unknown> }).handles.set(key, {
    actor,
    app,
    context,
    page: {},
    consoleErrors: [],
  });
};
const traces = (s: InstanceType<typeof Session>) =>
  (
    store()
      .prepare("SELECT path FROM artifacts WHERE run_id = ? AND kind = 'trace'")
      .all(s.runId) as { path: string }[]
  ).map(r => r.path);
const step = (s: InstanceType<typeof Session>, ok: boolean) =>
  s.recorder.step({ tool: 'orders_read', args: {}, ok, durationMs: 1 });

describe('which traces a run keeps', () => {
  it('drops them when the run passes with no failed step', async () => {
    const s = new Session('staging', false);
    open(s);
    step(s, true);
    s.recorder.finish('PASS', 'ok');
    await s.end();
    assert.deepEqual(traces(s), []);
    assert.equal(existsSync(join(s.recorder.dir, 'trace-buyer-store-1.zip')), false);
  });

  it('keeps one closed mid-run when the run later fails, and one a failed step made', async () => {
    const s = new Session('staging', false);
    open(s);
    await s.logout('buyer', 'store');
    s.recorder.finish('FAIL', 'the read differed');
    await s.end();
    assert.equal(traces(s).length, 1);

    const t = new Session('staging', false);
    open(t);
    step(t, false);
    t.recorder.finish('PASS', 'recovered');
    await t.end();
    assert.equal(traces(t).length, 1);
  });

  it('keeps them for a passing run that asked for them', async () => {
    const s = new Session('staging', false, true);
    open(s);
    s.recorder.finish('PASS', 'ok');
    await s.end();
    assert.equal(traces(s).length, 1);
  });

  it(
    prose`
    records ABORTED before closing, so a run ended without run_finish keeps its trace`,
    async () => {
      const s = await startSession({ env: 'staging', topic: 'trace check' });
      open(s);
      await endSession();
      assert.equal(s.recorder.verdict, 'ABORTED');
      assert.equal(traces(s).length, 1);
      assert.ok(
        existsSync(
          traces(s)[0]!.startsWith('/')
            ? traces(s)[0]!
            : join(process.env.WITNESS_RESULTS_DIR!, traces(s)[0]!),
        ),
      );
    },
  );
});
