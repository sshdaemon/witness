import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Client as ClientType } from '@modelcontextprotocol/client';

// The results store is chosen when paths.ts loads, so point it at a scratch folder first.
const results = mkdtempSync(join(tmpdir(), 'witness-lanes-'));
process.env.WITNESS_RESULTS_DIR = results;

const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');
await import('./helpers/app.js');
const { buildServer } = await import('../src/mcp/server.js');
const { getSession } = await import('../src/mcp/session.js');
const { parseCaseFile, runOrder } = await import('../src/runner/caseFile.js');
const { planLanes, undeclaredUses } = await import('../src/runner/lanes.js');
const { renderRuns } = await import('../src/ledger/qaMd.js');
const { laneClock, runLanes, verdictVersions } = await import('../src/runner/laneRun.js');
const { createViewer } = await import('../src/ui/server.js');

const call1 = (name: string, args: Record<string, unknown> = {}) =>
  [name, args] as [string, Record<string, unknown>];
const file = parseCaseFile({
  ticket: 'AB-60',
  fixtures: {
    capped: [call1('product_create', { name: 'capped' })],
    other: [call1('product_create', { name: 'other' })],
  },
  cases: {
    C1: { title: 'a', needs: ['capped'], block: [call1('stock'), call1('stock')] },
    C2: { title: 'b', needs: ['capped'], block: [call1('stock')] },
    C3: { title: 'c', after: ['C4'], block: [call1('stock')] },
    C4: { title: 'd', needs: ['other'], block: [call1('stock')] },
    C5: { title: 'e', uses: ['store-settings'], block: [call1('store_setting_set')] },
    C6: { title: 'f', uses: ['store-settings'], block: [call1('store_setting_set')] },
    C7: { title: 'g', block: [call1('staff_add'), call1('stock')] },
  },
});

describe('lane planning', () => {
  const order = runOrder(file, Object.keys(file.cases));

  it('keeps cases that share a fixture, an after chain or a uses value in one lane', () => {
    const lanes = planLanes(file, order, 3);
    const laneOf = (id: string) => lanes.findIndex(l => l.includes(id));
    assert.equal(lanes.length, 3);
    assert.equal(laneOf('C1'), laneOf('C2'), 'same fixture');
    assert.equal(laneOf('C3'), laneOf('C4'), 'after chain');
    assert.equal(laneOf('C5'), laneOf('C6'), 'same uses');
    assert.deepEqual(lanes.flat().toSorted(), order.toSorted(), 'every case runs once');
    for (const lane of lanes)
      assert.deepEqual(
        lane,
        order.filter(id => lane.includes(id)),
        'each lane keeps the run order',
      );
  });

  it('gives fewer lanes when the cases cannot be split, and one lane for one', () => {
    assert.equal(planLanes(file, ['C1', 'C2'], 3).length, 1);
    assert.deepEqual(planLanes(file, order, 1), [order]);
  });

  it('names cases that change shared state without saying so', () => {
    assert.deepEqual(undeclaredUses(file, order), [{ caseId: 'C7', uses: 'staff' }]);
  });
});

describe('running lanes', () => {
  it('reports a lane that does not start at once and still counts it ready', async () => {
    let now = 0;
    const clock = laneClock(2, () => now);
    const events: string[] = [];
    const settled = await runLanes(
      2,
      async i => {
        if (i === 1) throw new Error('server did not start');
        events.push('lane 1 waits');
        clock.markReady(0);
        return 'run-1';
      },
      {
        failed: (i, e) => events.push(`lane ${i + 1} failed: ${(e as Error).message}`),
        ended: i => clock.markReady(i),
      },
    );
    assert.deepEqual(
      settled.map(s => s.status),
      ['fulfilled', 'rejected'],
    );
    assert.ok(events.includes('lane 2 failed: server did not start'));
    now = 15 * 60_000 + 1;
    assert.equal(clock.over(0, 15), true, 'with every lane ready, the limit runs');
  });

  it('takes a final written before the lane waited only when it is written again', () => {
    const v = verdictVersions<{ cases?: object; final?: boolean }>();
    const text = '{"cases":{},"final":true}';
    v.startWaiting(1000);
    assert.equal(
      v.take({ text, mtimeMs: 500 })?.final,
      false,
      'meant for the lanes already waiting',
    );
    assert.equal(v.take({ text, mtimeMs: 500 }), undefined, 'the same version is not taken twice');
    assert.equal(
      v.take({ text, mtimeMs: 2000 })?.final,
      true,
      'the same text written again counts',
    );
    assert.equal(v.take({ text: '{"cases":', mtimeMs: 3000 }), undefined, 'half written');
    assert.equal(v.take(undefined), undefined);
  });

  it('starts the limit only once every lane is ready', () => {
    let now = 0;
    const clock = laneClock(2, () => now);
    clock.markReady(0);
    now = 60 * 60_000;
    assert.equal(clock.over(0, 15), false, 'lane 2 is still running');
    clock.markReady(1);
    now += 14 * 60_000;
    assert.equal(clock.over(0, 15), false);
    now += 2 * 60_000;
    assert.equal(clock.over(0, 15), true);
    assert.equal(clock.over(now - 60_000, 15), false, 'a new version restarts the wait');
  });
});

let client: ClientType;
type Envelope = { ok: boolean; code?: string; data?: Record<string, unknown> };
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Envelope> => {
  const res = (await client.callTool({ name, arguments: args })) as {
    structuredContent?: Envelope;
  };
  return res.structuredContent!;
};
let viewer: Server;
let base: string;

before(async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(serverSide);
  client = new Client({ name: 'lanes-test', version: '0.0.0' });
  await client.connect(clientSide);
  viewer = createViewer();
  await new Promise<void>(resolve => viewer.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(viewer.address() as AddressInfo).port}`;
});
after(async () => {
  if (getSession()) await call('session_end');
  await client.close();
  viewer.close();
  rmSync(results, { recursive: true, force: true });
});

describe('a batch of lanes', () => {
  const runIds: string[] = [];

  it('shares one run number, each lane labelled with its lane', async () => {
    await call('session_start', { ticket: 'AB-60', env: 'staging' });
    await call('run_finish', { verdict: 'PASS', summary: 'run 1' });
    await call('session_end');
    for (const lane of [1, 2]) {
      const s = await call('session_start', {
        ticket: 'AB-60',
        env: 'staging',
        batch: 'b20261104-abcdef',
        lane,
      });
      assert.equal(s.data!.runNumber, 2);
      assert.equal(s.data!.label, `AB-60 run 2 lane ${lane}`);
      runIds.push(String(s.data!.runId));
      await call('case_begin', { caseId: lane === 1 ? 'C1' : 'C4' });
      await call('case_end', {
        caseId: lane === 1 ? 'C1' : 'C4',
        result: lane === 1 ? 'PASS' : 'FAIL',
      });
      await call('run_finish', { summary: `lane ${lane}` });
      await call('session_end');
    }
    const next = await call('session_start', {
      ticket: 'AB-60',
      env: 'staging',
    });
    assert.equal(next.data!.runNumber, 3, 'the batch took one number');
    await call('run_finish', { verdict: 'PASS', summary: 'run 3' });
    await call('session_end');
  });

  it('is one column of the ticket grid, failing when a lane failed', async () => {
    const t = await (await fetch(`${base}/api/tickets/AB-60`)).json();
    const batch = t.runs.find((r: { runNumber: number }) => r.runNumber === 2);
    assert.equal(batch.id, 'b20261104-abcdef');
    assert.equal(batch.verdict, 'FAIL');
    assert.equal(batch.label, 'AB-60 run 2');
    assert.deepEqual(
      batch.lanes.map((l: { lane: number }) => l.lane),
      [1, 2],
    );
    const c1 = t.cases.find((c: { caseId: string }) => c.caseId === 'C1');
    const c4 = t.cases.find((c: { caseId: string }) => c.caseId === 'C4');
    assert.equal(c1.cells['b20261104-abcdef'].result, 'PASS');
    assert.equal(c4.cells['b20261104-abcdef'].result, 'FAIL');
    const run = await (await fetch(`${base}/api/runs/${runIds[1]}`)).json();
    assert.deepEqual(
      run.lanes.map((l: { lane: number }) => l.lane),
      [1, 2],
      'a lane links its siblings',
    );
  });

  it('writes one ledger line per lane and keeps it after retention', () => {
    const line = renderRuns(
      [
        {
          id: '20261104100000-aaaaaa',
          run_number: 2,
          env: 'local',
          started_at: '2026-11-04T10:00:00Z',
          verdict: 'FAIL',
          lane: 2,
        },
      ],
      [],
    );
    assert.equal(
      line,
      '- Run 2 lane 2 (local, 2026-11-04, 20261104100000-aaaaaa): FAIL. No cases recorded.',
    );
    assert.equal(renderRuns([], [], line), line, 'kept when the store no longer has it');
    const two = renderRuns(
      [
        {
          id: '20261104100000-zzzzzz',
          run_number: 2,
          env: 'local',
          started_at: '2026-11-04T10:00:00Z',
          verdict: 'PASS',
          lane: 1,
        },
        {
          id: '20261104100000-aaaaaa',
          run_number: 2,
          env: 'local',
          started_at: '2026-11-04T10:00:00Z',
          verdict: 'FAIL',
          lane: 2,
        },
      ],
      [],
    );
    assert.match(
      two,
      /^- Run 2 lane 1 .*\n- Run 2 lane 2 /,
      'lanes in lane order, whatever their ids',
    );
    assert.match(renderRuns([], [], two.split('\n').toReversed().join('\n')), /^- Run 2 lane 1 /);
  });
});
