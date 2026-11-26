import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { prose } from '../src/prose.js';

const dir = mkdtempSync(join(tmpdir(), 'witness-evidence-'));
process.env.WITNESS_RESULTS_DIR = dir;

const { Recorder } = await import('../src/mcp/recorder.js');
const { listEvidence, markPosted, pickEvidence, removeEvidence } =
  await import('../src/mcp/evidence.js');
const { ToolError } = await import('../src/errors.js');
const { createViewer } = await import('../src/ui/server.js');

const recorder = new Recorder('20261016100000-evd', 'staging', 'evd', { topic: 'Evidence' });
recorder.beginCall('orders_read');
const frame = recorder.shotPath('frame');
const before = recorder.shotPath('verify-before');
const verify = recorder.shotPath('verify');
writeFileSync(frame, 'frame');
writeFileSync(before, 'before');
writeFileSync(verify, 'verify');
const step = recorder.step({
  tool: 'orders_read',
  args: {},
  ok: true,
  durationMs: 1,
  screenshotPaths: [frame, before, verify],
});
recorder.step({ tool: 'login', args: {}, ok: true, durationMs: 1 });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof ToolError ? e.code : String(e);
  }
  return 'no error';
};

describe('evidence', () => {
  it(
    prose`
    copies the step's last screenshot into the ticket folder, named after the case and caption`,
    () => {
      const e = pickEvidence({
        runId: recorder.runId,
        step,
        ticket: 'AB-1',
        caseId: 'C3',
        caption: 'Orders list shows the new order',
      });
      assert.equal(e.path, join(dir, 'evidence', 'AB-1', 'c3-orders-list-shows-the-new-order.png'));
      assert.equal(readFileSync(e.path, 'utf8'), 'verify');
      assert.deepEqual([e.tool, e.step, e.case, e.postedUrl], ['orders_read', step, 'C3', null]);
    },
  );

  it(
    prose`
    picks a frame by position or by part of its name, and never overwrites an earlier pick`,
    () => {
      const first = pickEvidence({
        runId: recorder.runId,
        step,
        shot: 1,
        ticket: 'AB-1',
        caseId: 'C3',
        caption: 'Orders list shows the new order',
      });
      assert.match(first.path, /-2\.png$/);
      assert.equal(readFileSync(first.path, 'utf8'), 'frame');
      assert.equal(
        readFileSync(
          pickEvidence({
            runId: recorder.runId,
            step,
            shot: 'verify',
            ticket: 'AB-2',
            caption: 'x y z',
          }).path,
          'utf8',
        ),
        'verify',
      );
    },
  );

  it('lists, records the upload and removes', () => {
    const [a, b] = listEvidence('AB-1');
    assert.equal(
      markPosted(a!.id, 'https://uploads.example.test/a.png').postedUrl,
      'https://uploads.example.test/a.png',
    );
    removeEvidence(b!.id);
    assert.equal(existsSync(b!.path), false);
    assert.deepEqual(
      listEvidence('AB-1').map(e => e.id),
      [a!.id],
    );
  });

  it('takes a label exactly before part of a name, and refuses a part that matches several', () => {
    const pick = (shot: string) =>
      readFileSync(
        pickEvidence({ runId: recorder.runId, step, shot, ticket: 'AB-3', caption: 'abc' }).path,
        'utf8',
      );
    assert.equal(pick('verify'), 'verify');
    assert.equal(pick('verify-before'), 'before');
    assert.equal(
      code(() =>
        pickEvidence({ runId: recorder.runId, step, shot: 'ver', ticket: 'AB-3', caption: 'abc' }),
      ),
      'SHOT_AMBIGUOUS',
    );
  });

  it('refuses what it cannot find', () => {
    assert.equal(
      code(() => pickEvidence({ runId: recorder.runId, step: 99, ticket: 'AB-1', caption: 'abc' })),
      'STEP_NOT_FOUND',
    );
    assert.equal(
      code(() =>
        pickEvidence({ runId: recorder.runId, step: step + 1, ticket: 'AB-1', caption: 'abc' }),
      ),
      'NO_SCREENSHOT',
    );
    assert.equal(
      code(() =>
        pickEvidence({ runId: recorder.runId, step, shot: 5, ticket: 'AB-1', caption: 'abc' }),
      ),
      'SHOT_NOT_FOUND',
    );
    rmSync(verify);
    assert.equal(
      code(() => pickEvidence({ runId: recorder.runId, step, ticket: 'AB-1', caption: 'abc' })),
      'SCREENSHOT_GONE',
    );
    assert.equal(
      code(() => markPosted(999, 'https://x')),
      'EVIDENCE_NOT_FOUND',
    );
  });

  it(
    prose`
    shows each ticket and serves its screenshots in the viewer, nothing outside the evidence
    folder`,
    async () => {
      const server = createViewer();
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      try {
        const tickets = (await (await fetch(`${url}/api/evidence`)).json()) as {
          ticket: string;
          items: { url: string; postedUrl: string | null }[];
        }[];
        assert.deepEqual(tickets.map(t => t.ticket).toSorted(), ['AB-1', 'AB-2', 'AB-3']);
        const first = tickets.find(t => t.ticket === 'AB-1')!.items[0]!;
        assert.equal(first.postedUrl, 'https://uploads.example.test/a.png');
        const img = await fetch(`${url}${first.url}`);
        assert.equal(img.status, 200);
        assert.equal(await img.text(), 'verify');
        assert.equal((await fetch(`${url}/evidence-files/999`)).status, 404);
      } finally {
        server.close();
      }
    },
  );
});
