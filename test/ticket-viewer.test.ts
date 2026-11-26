import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

// A ticket tested over three runs: run 1 removed by retention, run 2 on the old store build, run 3
// on the new one.
const dir = mkdtempSync(join(tmpdir(), 'witness-ticket-viewer-'));
process.env.WITNESS_RESULTS_DIR = dir;

const { store } = await import('../src/mcp/store.js');
const d = store();
// Run 3 also had the admin site up, which says nothing about the store under test.
const build = (sha: string) =>
  JSON.stringify({
    store: { branch: null, sha, dirty: false },
    ...(sha === 'bbb' ? { admin: { branch: null, sha: 'rrr', dirty: true } } : {}),
  });
const run = (id: string, n: number, sha: string, verdict: string) =>
  d
    .prepare(
      `
        INSERT INTO runs (id, env, run_tag, started_at, verdict, ticket, run_number, label,
          app_versions, topic)
        VALUES (?, 'local', 't', ?, ?, 'AB-1', ?, ?, ?, 'Shared product')
      `,
    )
    .run(id, `2026-11-0${n}T10:00:00Z`, verdict, n, `AB-1 run ${n}`, build(sha));
const result = (
  runId: string,
  n: number,
  caseId: string,
  value: string,
  sha: string,
  extra: Record<string, unknown> = {},
) =>
  d
    .prepare(
      `
        INSERT INTO case_results (run_id, ticket, case_id, run_number, result, step_from, step_to,
          judged_by, checks_result, checks_json, note, app_versions, finished_at)
        VALUES (?, 'AB-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      runId,
      caseId,
      n,
      value,
      (extra.from as number) ?? null,
      (extra.to as number) ?? null,
      (extra.judgedBy as string) ?? 'session',
      (extra.checksResult as string) ?? null,
      extra.checks ? JSON.stringify(extra.checks) : null,
      (extra.note as string) ?? null,
      build(sha),
      `2026-11-0${n}T10:30:00Z`,
    );

// Run 1 is gone from runs, only its case results remain.
result('20261101100000-gone01', 1, 'C1', 'BLOCKED', 'aaa');
run('20261102100000-old002', 2, 'aaa', 'FAIL');
result('20261102100000-old002', 2, 'C1', 'PASS', 'aaa', { from: 2, to: 4 });
result('20261102100000-old002', 2, 'C10', 'FAIL', 'aaa', {
  from: 5,
  to: 7,
  judgedBy: 'checks',
  checksResult: 'FAIL',
  checks: [{ seq: 6, path: 'items', check: 'count', want: 1, got: 2, ok: false }],
});
run('20261103100000-new003', 3, 'bbb', 'PASS');
result('20261103100000-new003', 3, 'C10', 'PASS', 'bbb', {
  from: 2,
  to: 3,
  checksResult: 'FAIL',
  note: 'read before the refresh',
});
result('20261103100000-new003', 3, 'C2', 'NOT_RUN', 'bbb');
d.prepare(
  `
    INSERT INTO artifacts (run_id, step_seq, kind, path, bytes) VALUES
      ('20261102100000-old002', 3, 'screenshot', 'runs/20261102100000-old002/screenshots/a.png', 1),
      ('20261102100000-old002', 9, 'screenshot', 'runs/20261102100000-old002/screenshots/b.png', 1)
  `,
).run();
d.prepare(
  `
    INSERT INTO evidence (ticket, case_id, caption, path, run_id, step_seq, source, created_at)
    VALUES ('AB-1', 'C1', 'Stock shows 1 left', 'evidence/AB-1/c1.png', '20261102100000-old002', 3,
      'runs/x.png', '2026-11-02T11:00:00Z')
  `,
).run();

// C10 changed in its case file after run 2.
d.prepare(
  `
    INSERT INTO cases (ticket, case_id, title, block_json, hash, updated_at)
    VALUES ('AB-1', 'C10', 'Stock left', '[]', 'h2', '2026-11-03T09:00:00Z')
  `,
).run();
d.prepare(
  "UPDATE case_results SET case_hash = 'h1' WHERE case_id = 'C10' AND run_number = 2",
).run();
d.prepare(
  "UPDATE case_results SET case_hash = 'h2' WHERE case_id = 'C10' AND run_number = 3",
).run();

const { createViewer } = await import('../src/ui/server.js');

describe('tickets in the viewer', () => {
  let server: Server;
  let base: string;
  before(async () => {
    server = createViewer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());
  // oxlint-disable-next-line typescript/no-explicit-any -- assertions read deep into the API's data
  const get = async (path: string): Promise<any> => (await fetch(base + path)).json();

  it('lists the ticket with the latest result of each case', async () => {
    const [t] = await get('/api/tickets');
    assert.equal(t.ticket, 'AB-1');
    assert.equal(t.runs, 3, 'the removed run still counts');
    assert.equal(t.cases, 3);
    assert.deepEqual(t.counts, { PASS: 2, NOT_RUN: 1 });
  });

  it('lays the cases out against the runs, removed ones included, in case order', async () => {
    const t = await get('/api/tickets/ab-1');
    assert.deepEqual(
      t.runs.map((r: { runNumber: number; pruned: boolean }) => [r.runNumber, r.pruned]),
      [
        [1, true],
        [2, false],
        [3, false],
      ],
    );
    assert.deepEqual(
      t.cases.map((c: { caseId: string }) => c.caseId),
      ['C1', 'C2', 'C10'],
    );
    const c1 = t.cases[0];
    assert.equal(c1.cells['removed-1'].result, 'BLOCKED', 'a removed run is keyed by its number');
    assert.equal(c1.current.result, 'PASS');
    assert.equal(c1.current.runNumber, 2);
    assert.equal(c1.current.olderBuild, true, 'run 3 was served by another store build');
    assert.equal(c1.evidence, 1);
    const c10 = t.cases[2];
    assert.equal(c10.current.olderBuild, false, 'an app only run 3 had up is not compared');
    assert.equal(c10.current.checksResult, 'FAIL', 'the overridden checks stay visible');
  });

  it("shows a case's history with its checks, step screenshots and evidence", async () => {
    const c = await get('/api/tickets/AB-1/cases/C10');
    assert.equal(c.definition.title, 'Stock left');
    assert.deepEqual(
      c.history.map((h: { earlierVersion: boolean }) => h.earlierVersion),
      [true, false],
      'run 2 ran the case before it changed',
    );
    assert.deepEqual(
      c.history.map((h: { runNumber: number; result: string }) => [h.runNumber, h.result]),
      [
        [2, 'FAIL'],
        [3, 'PASS'],
      ],
    );
    assert.equal(c.history[0].checks[0].got, 2);
    assert.equal(c.history[1].note, 'read before the refresh');
    const c1 = await get('/api/tickets/AB-1/cases/C1');
    assert.equal(c1.history[0].run, null, 'run 1 was removed');
    assert.deepEqual(
      c1.history[1].screenshots.map((s: { step: number }) => s.step),
      [3],
      'only the screenshots inside the case',
    );
    assert.equal(c1.evidence[0].caption, 'Stock shows 1 left');
  });

  it('gives a run its cases and the runs list their ticket and number', async () => {
    const r = await get('/api/runs/20261102100000-old002');
    assert.deepEqual(
      r.cases.map((c: { caseId: string; steps: unknown }) => [c.caseId, c.steps]),
      [
        ['C1', { from: 2, to: 4 }],
        ['C10', { from: 5, to: 7 }],
      ],
    );
    const runs = await get('/api/runs');
    assert.equal(runs[0].label, 'AB-1 run 3');
    assert.equal(runs[0].run_number, 3);
  });

  it('answers an unknown ticket or case, or a broken link, with 404', async () => {
    for (const path of [
      '/api/tickets/AB-404',
      '/api/tickets/AB-1/cases/C99',
      '/api/tickets/%E0%A4%A',
      '/api/tickets/AB-1/cases/%E0%A4%A',
    ])
      assert.equal((await fetch(base + path)).status, 404, path);
  });
});
