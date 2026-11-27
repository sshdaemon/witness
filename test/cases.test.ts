import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import type { Client as ClientType } from '@modelcontextprotocol/client';

// The results store is chosen when paths.ts loads, so point it at a scratch folder before importing
// the server.
const results = mkdtempSync(join(tmpdir(), 'witness-cases-'));
process.env.WITNESS_RESULTS_DIR = results;

const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');
await import('./helpers/app.js');
const { buildServer } = await import('../src/mcp/server.js');
const { getSession } = await import('../src/mcp/session.js');
const { store } = await import('../src/mcp/store.js');
const { pruneOldRuns } = await import('../src/mcp/retention.js');

// oxlint-disable-next-line typescript/no-explicit-any -- assertions read deep into each tool's own data
type ToolData = any;
type Envelope = { ok: boolean; code?: string; message?: string; data?: ToolData };

let client: ClientType;
const call = async (name: string, args: Record<string, unknown> = {}): Promise<Envelope> => {
  const res = (await client.callTool({ name, arguments: args })) as {
    structuredContent?: Envelope;
  };
  return res.structuredContent!;
};
const start = (args: Record<string, unknown> = {}) =>
  call('session_start', { ticket: 'AB-1', env: 'staging', ...args });
const end = async () => {
  if (getSession()) await call('session_end');
};

before(async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(serverSide);
  client = new Client({ name: 'cases-test', version: '0.0.0' });
  await client.connect(clientSide);
});

after(async () => {
  await end();
  await client.close();
  rmSync(results, { recursive: true, force: true });
});

describe('run numbers', () => {
  it('numbers runs per ticket and labels them "<ticket> run <n>"', async () => {
    const first = await start({ ticket: 'AB-1' });
    assert.equal(first.data.runNumber, 1);
    assert.equal(first.data.label, 'AB-1 run 1');
    assert.match(first.data.namePrefix, / AB-1 run 1$/);
    await end();
    const second = await start({ ticket: 'ab-1' });
    assert.equal(second.data.runNumber, 2, 'tickets match whatever their case');
    await end();
    const other = await start({ ticket: 'AB-2', label: 'PR 7 run 3' });
    assert.equal(other.data.runNumber, 1);
    assert.equal(other.data.label, 'PR 7 run 3', 'a label given wins');
    await end();
  });

  it('starts after the runs numbered by hand, and keeps counting from there', async () => {
    assert.equal((await start({ ticket: 'AB-3', firstRun: 20 })).data.runNumber, 20);
    await end();
    assert.equal((await start({ ticket: 'AB-3', firstRun: 20 })).data.runNumber, 21);
    await end();
  });

  it('refuses a run without a ticket', async () => {
    const r = await call('session_start', { env: 'staging' });
    assert.equal(r?.ok ?? false, false);
    assert.equal(getSession(), undefined);
  });

  it('never gives two processes the same number', async () => {
    const run = promisify(execFile);
    const helper = resolve(import.meta.dirname, 'helpers/number-runs.ts');
    const tsx = resolve(import.meta.dirname, '../node_modules/.bin/tsx');
    const outs = await Promise.all(
      ['a', 'b'].map(p => run(tsx, [helper, results, 'AB-PAR', p, '15'])),
    );
    const numbers = outs.flatMap(o => JSON.parse(o.stdout) as number[]).toSorted((x, y) => x - y);
    assert.deepEqual(
      numbers,
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
  });
});

describe('cases in a run', () => {
  it('records each case with the steps between its case_begin and case_end', async () => {
    await start({ ticket: 'AB-10' });
    const begin = await call('case_begin', { caseId: 'C1' });
    assert.equal(begin.ok, true);
    assert.equal(begin.data.fromStep, 2);
    await call('runs_list', { limit: 1 });
    const done = await call('case_end', { caseId: 'C1', result: 'PASS', actual: '1 left' });
    assert.deepEqual(done.data.steps, { from: 2, to: 4 });
    assert.equal(done.data.judgedBy, 'session');
  });

  it('keeps one case open at a time and each case once a run', async () => {
    await call('case_begin', { caseId: 'C2' });
    assert.equal((await call('case_begin', { caseId: 'C3' })).code, 'CASE_OPEN');
    assert.equal((await call('case_end', { caseId: 'C3', result: 'PASS' })).code, 'CASE_OPEN');
    assert.equal((await call('run_finish', { summary: 'x' })).code, 'CASE_OPEN');
    await call('case_end', { caseId: 'C2', result: 'PASS' });
    assert.equal((await call('case_begin', { caseId: 'C2' })).code, 'CASE_ALREADY_RUN');
  });

  it('records a case that could not run without case_begin, and only that', async () => {
    assert.equal(
      (await call('case_end', { caseId: 'C4', result: 'FAIL' })).code,
      'CASE_NOT_STARTED',
    );
    const r = await call('case_end', { caseId: 'C4', result: 'NOT_RUN', note: 'C2 failed' });
    assert.equal(r.data.result, 'NOT_RUN');
    assert.equal(r.data.steps, null);
  });

  it('keeps what the checks gave, and needs a note to judge otherwise', async () => {
    await call('case_begin', { caseId: 'C5' });
    const checks = [
      { seq: 9, path: 'items', check: 'count', want: 1, got: 1, ok: true },
      {
        seq: 9,
        path: 'items[0].stock',
        check: 'equals',
        want: '1 left',
        got: '2 left',
        ok: false,
      },
    ];
    const byChecks = await call('case_end', {
      caseId: 'C5',
      result: 'FAIL',
      judgedBy: 'checks',
      checks,
    });
    assert.equal(byChecks.data.checksResult, 'FAIL');
    assert.equal((await call('case_end', { caseId: 'C5', result: 'PASS' })).code, 'NOTE_REQUIRED');
    const judged = await call('case_end', {
      caseId: 'C5',
      result: 'PASS',
      note: 'the second order was declined before the read',
    });
    assert.equal(judged.data.result, 'PASS');
    assert.equal(judged.data.judgedBy, 'session');
    assert.equal(judged.data.checksResult, 'FAIL', 'the checks stay on record');
    assert.deepEqual(judged.data.steps, { from: 13, to: 14 }, 'the step range stays');
  });

  it("drops a replaced result's note unless the result stays", async () => {
    await call('case_begin', { caseId: 'C6' });
    await call('case_end', { caseId: 'C6', result: 'BLOCKED', note: 'waiting' });
    const same = await call('case_end', { caseId: 'C6', result: 'BLOCKED', actual: 'still' });
    assert.equal(same.ok, true);
    await call('case_end', { caseId: 'C6', result: 'PASS' });
    const row = getSession()!.recorder.runId;
    const got = (await call('run_get', { id: row })).data.cases.find(
      (c: ToolData) => c.caseId === 'C6',
    );
    assert.equal(got.result, 'PASS');
    assert.equal(got.note, null);
  });

  it('takes the run verdict from its cases', async () => {
    assert.equal(
      (await call('run_finish', { verdict: 'PASS', summary: 'x' })).code,
      'VERDICT_MISMATCH',
      'C4 did not run',
    );
    const r = await call('run_finish', { summary: 'C4 did not run' });
    assert.equal(r.data.verdict, 'BLOCKED');
    const runId = r.data.runId;
    await end();
    const got = await call('run_get', { id: runId });
    assert.deepEqual(
      got.data.cases.map((c: ToolData) => [c.caseId, c.result, c.runNumber]),
      [
        ['C1', 'PASS', 1],
        ['C2', 'PASS', 1],
        ['C5', 'PASS', 1],
        ['C6', 'PASS', 1],
        ['C4', 'NOT_RUN', 1],
      ],
    );
    assert.equal(got.data.cases[2].checks.length, 2);
    assert.equal(got.data.run.ticket, 'AB-10');
    assert.equal((await call('runs_list', { ticket: 'ab-10' })).data.runs.length, 1);
  });

  it('fails a run with a failed case, and needs a verdict without cases', async () => {
    await start({ ticket: 'AB-11' });
    await call('case_begin', { caseId: 'C1' });
    await call('case_end', { caseId: 'C1', result: 'FAIL' });
    await call('case_end', { caseId: 'C2', result: 'NOT_RUN' });
    assert.equal((await call('run_finish', { summary: 'x' })).data.verdict, 'FAIL');
    await end();
    await start();
    assert.equal((await call('run_finish', { summary: 'x' })).code, 'VERDICT_REQUIRED');
    assert.equal((await call('run_finish', { verdict: 'PASS', summary: 'x' })).ok, true);
    await end();
  });

  it('closes a case left open as BLOCKED when the session ends', async () => {
    await start({ ticket: 'AB-12' });
    await call('case_begin', { caseId: 'C1' });
    const runId = getSession()!.runId;
    await end();
    const got = await call('run_get', { id: runId });
    assert.equal(got.data.run.verdict, 'ABORTED');
    assert.equal(got.data.cases[0].result, 'BLOCKED');
    assert.match(got.data.cases[0].note, /before case_end/);
  });
});

describe('what a case may record', () => {
  const failing = [{ seq: 2, path: 'x', check: 'equals', want: 1, got: 2, ok: false }];

  it("stores a case under the run's own ticket, whatever its spelling, and no other", async () => {
    await start({ ticket: 'AB-20' });
    assert.equal(
      (await call('case_begin', { caseId: 'C1', ticket: 'AB-21' })).code,
      'TICKET_MISMATCH',
    );
    assert.equal(
      (await call('case_begin', { caseId: 'C1', ticket: 'ab-20' })).data.ticket,
      'AB-20',
    );
    await call('case_end', { caseId: 'C1', ticket: 'ab-20', result: 'PASS' });
    assert.equal(
      (await call('case_begin', { caseId: 'C1', ticket: 'ab-20' })).code,
      'CASE_ALREADY_RUN',
    );
  });

  it('refuses a checks verdict the checks did not give, and an unexplained one', async () => {
    await call('case_begin', { caseId: 'C2' });
    assert.equal(
      (
        await call('case_end', {
          caseId: 'C2',
          result: 'PASS',
          judgedBy: 'checks',
          checks: failing,
        })
      ).code,
      'CHECKS_MISMATCH',
    );
    assert.equal(
      (await call('case_end', { caseId: 'C2', result: 'PASS', checks: failing })).code,
      'NOTE_REQUIRED',
    );
    assert.equal(
      (await call('case_end', { caseId: 'C2', result: 'PASS', judgedBy: 'checks' })).code,
      'CHECKS_MISMATCH',
      'no checks to judge by',
    );
    await call('case_end', { caseId: 'C2', result: 'FAIL', judgedBy: 'checks', checks: failing });
    assert.equal(
      (await call('case_end', { caseId: 'C2', result: 'PASS', judgedBy: 'checks' })).code,
      'CHECKS_MISMATCH',
    );
  });

  it('records nothing more once the run has its verdict', async () => {
    await call('run_finish', { summary: 'C2 failed' });
    assert.equal((await call('case_begin', { caseId: 'C3' })).code, 'RUN_FINISHED');
    assert.equal(
      (await call('case_end', { caseId: 'C2', result: 'PASS', note: 'late' })).code,
      'RUN_FINISHED',
    );
    await end();
  });
});

describe('pruning', () => {
  it('keeps case results and run numbers after their runs are gone', async () => {
    const years = new Date(Date.now() + 400 * 86_400_000);
    const pruned = pruneOldRuns(years, 14, 3);
    assert.ok(pruned.runs.length > 0);
    assert.equal((store().prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n, 0);
    const kept = store()
      .prepare("SELECT case_id, run_number FROM case_results WHERE ticket = 'AB-10'")
      .all() as { case_id: string; run_number: number }[];
    assert.equal(kept.length, 5);
    assert.equal((await start({ ticket: 'AB-10' })).data.runNumber, 2);
    await end();
  });
});
