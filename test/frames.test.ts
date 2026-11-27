import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

// The store reads its folder at import time, so point it at a throwaway one first.
const dir = mkdtempSync(join(tmpdir(), 'witness-frames-store-'));
process.env.WITNESS_RESULTS_DIR = dir;

const { Recorder } = await import('../src/mcp/recorder.js');
const { store } = await import('../src/mcp/store.js');
const { createViewer } = await import('../src/ui/server.js');

const RUN = '20260101000000-frm';
const shot = (name: string) => join(dir, 'runs', RUN, 'screenshots', name);
const recorder = new Recorder(RUN, 'local', 'frm', {});
const base = { args: {}, ok: true, durationMs: 5 };
const many = recorder.step({
  ...base,
  tool: 'product_add_variant',
  screenshotPaths: [shot('step-1-1.png'), shot('step-1-2.png'), shot('step-1-3.png')],
});
const none = recorder.step({ ...base, tool: 'login' });
const failed = recorder.step({
  ...base,
  tool: 'admin_products',
  ok: false,
  errorCode: 'TIMEOUT',
  screenshotPaths: [shot('step-2-1.png'), shot('fail-2.png')],
});

describe('several frames per step', () => {
  let server: Server;
  let url: string;
  before(async () => {
    server = createViewer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it('keeps one artifact per frame, in order, with paths relative to the results folder', () => {
    const artifacts = store()
      .prepare(
        `
          SELECT path FROM artifacts
          WHERE run_id = ? AND step_seq = ? AND kind = 'screenshot'
          ORDER BY rowid
        `,
      )
      .all(RUN, many) as { path: string }[];
    assert.deepEqual(
      artifacts.map(a => a.path),
      ['step-1-1.png', 'step-1-2.png', 'step-1-3.png'].map(n => `runs/${RUN}/screenshots/${n}`),
    );
    assert.equal(none, 2);
  });

  it("names a call's screenshots after its step and tool", () => {
    const r = new Recorder('20260101000001-nam', 'local', 'nam', {});
    r.step({ ...base, tool: 'login' });
    r.beginCall('orders_read');
    const names = [r.shotPath('frame'), r.shotPath('frame'), r.shotPath('verify')].map(p =>
      p.split('/').pop(),
    );
    assert.deepEqual(names, [
      '0002-orders_read-frame.png',
      '0002-orders_read-frame-2.png',
      '0002-orders_read-verify.png',
    ]);
  });

  it("serves a step's frames in the order they were taken, the failure shot last", async () => {
    const detail = (await (await fetch(`${url}/api/runs/${RUN}`)).json()) as {
      steps: { seq: number; screenshot: string | null; screenshots: string[] }[];
    };
    const names = (seq: number) =>
      detail.steps.find(s => s.seq === seq)!.screenshots.map(u => u.split('/').pop());
    assert.deepEqual(names(many), ['step-1-1.png', 'step-1-2.png', 'step-1-3.png']);
    assert.deepEqual(names(failed), ['step-2-1.png', 'fail-2.png']);
    assert.deepEqual(names(none), []);
  });
});
