import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

// The store reads its folder at import time, so point it at a throwaway one first.
process.env.WITNESS_RESULTS_DIR = mkdtempSync(join(tmpdir(), 'witness-ticket-runs-'));

const { Recorder } = await import('../src/mcp/recorder.js');
const { buildReport } = await import('../src/mcp/report.js');
const { listRuns, store, titleWithoutTicket } = await import('../src/mcp/store.js');
const { createViewer } = await import('../src/ui/server.js');

const builds = { store: { branch: 'feat/x', sha: 'abc1234', dirty: true } };
const run = (
  id: string,
  about: {
    ticket?: string;
    title?: string;
    branch?: string;
    kind?: string;
    batch?: string;
    lane?: number;
  },
  verdict?: 'PASS' | 'FAIL',
  summary = '',
) => {
  const r = new Recorder(id, 'local', id.slice(-3), about, builds);
  if (verdict) r.finish(verdict, summary);
  return r;
};

run(
  '20260101000001-aaa',
  { ticket: 'AB-1', title: 'AB-1 old title', branch: 'feat/x' },
  'FAIL',
  'ok: no filter; FAIL: legacy id',
);
run(
  '20260101000002-bbb',
  { ticket: 'ab-1', title: 'ab-1 stock limit', branch: 'feat/x' },
  'PASS',
  'ok: no filter; ok: legacy id',
);
run('20260101000003-ccc', { ticket: 'TOOL-search', kind: 'tool' }, 'PASS', 'tool answers');
// Runs from before every run had a ticket: one with a topic, one with only a use-case slug.
run('20260101000004-ddd', {}, 'PASS');
run('20260101000005-eee', {});
store()
  .prepare('UPDATE runs SET topic = ?, use_case_id = ? WHERE id = ?')
  .run('an old topic', 'old-slug', '20260101000004-ddd');

// A ticket whose runs retention removed: only its case results are left, run 2's last.
const result = store().prepare(
  `
    INSERT INTO case_results (run_id, ticket, case_id, result, run_number, judged_by, finished_at)
    VALUES (?, 'OLD-1', ?, ?, ?, 'checks', ?)
  `,
);
result.run('gone-1', 'C1', 'FAIL', 1, '2025-01-01T00:00:00Z');
result.run('gone-2', 'C1', 'PASS', 2, '2025-01-02T00:00:00Z');
result.run('gone-2', 'C2', 'NOT_RUN', 2, '2025-01-02T00:00:00Z');

// Results with no run number, from two runs: the newer one passed.
result.run('gone-a', 'C1', 'FAIL', null, '2025-02-01T00:00:00Z');
result.run('gone-b', 'C1', 'PASS', null, '2025-02-02T00:00:00Z');
store()
  .prepare("UPDATE case_results SET ticket = 'OLD-2' WHERE run_id IN ('gone-a', 'gone-b')")
  .run();

// One run in two lanes: the lane that started first failed.
run('20260101000006-ln1', { ticket: 'LN-1', batch: 'batch-ln-1', lane: 1 }, 'FAIL');
run('20260101000007-ln2', { ticket: 'LN-1', batch: 'batch-ln-1', lane: 2 }, 'PASS');

type Ticket = {
  ticket: string | null;
  runs: number;
  cases: number;
  verdict: string | null;
  tool: boolean;
};

describe('runs by ticket', () => {
  let server: Server;
  let base: string;
  const json = async <T>(path: string) => (await (await fetch(`${base}${path}`)).json()) as T;
  before(async () => {
    server = createViewer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it('lists tickets with their latest run and tool flag, ticketless runs as one', async () => {
    const tickets = await json<Ticket[]>('/api/tickets');
    const ab = tickets.find(t => t.ticket?.toLowerCase() === 'ab-1');
    assert.equal(ab?.runs, 2);
    assert.equal(ab?.verdict, 'PASS');
    assert.equal(ab?.tool, false);
    assert.equal(tickets.find(t => t.ticket === 'TOOL-search')?.tool, true);
    const none = tickets.find(t => t.ticket === null);
    assert.equal(none?.runs, 2);
  });

  it("gives a ticket whose runs are gone the verdict of its newest run's cases", async () => {
    const tickets = await json<Ticket[]>('/api/tickets');
    const old = tickets.find(t => t.ticket === 'OLD-1');
    assert.equal(old?.verdict, 'BLOCKED');
    assert.equal(old?.runs, 2);
  });

  it("gives a removed run's column on the ticket page the verdict of its cases", async () => {
    const detail = await json<{ runs: { verdict: string | null; pruned: boolean }[] }>(
      '/api/tickets/OLD-1',
    );
    assert.deepEqual(
      detail.runs.map(r => [r.verdict, r.pruned]),
      [
        ['FAIL', true],
        ['BLOCKED', true],
      ],
    );
  });

  it('takes the verdict of a run in lanes from its worst lane', async () => {
    const tickets = await json<Ticket[]>('/api/tickets');
    assert.equal(tickets.find(t => t.ticket === 'LN-1')?.verdict, 'FAIL');
  });

  it('takes only the newest run when removed runs left results without a number', async () => {
    const tickets = await json<Ticket[]>('/api/tickets');
    assert.equal(tickets.find(t => t.ticket === 'OLD-2')?.verdict, 'PASS');
  });

  it('serves the page, its code, the logo and only the Shoelace files it needs', async () => {
    const page = await fetch(`${base}/`);
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self';/);
    assert.match(await page.text(), /<witness-app/);
    const code = await fetch(`${base}/app.js`);
    assert.equal(code.status, 200);
    assert.match(code.headers.get('content-type') ?? '', /javascript/);
    assert.match(await code.text(), /witness-app/);
    assert.equal((await fetch(`${base}/logo.png`)).headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${base}/vendor/shoelace/themes/light.css`)).status, 200);
    for (const path of [
      '..%2Fpackage.json',
      'shoelace.d.ts',
      'nope.js',
      'themes/../../package.json',
    ])
      assert.equal((await fetch(`${base}/vendor/shoelace/${path}`)).status, 404, path);
  });

  it("keeps each ticket's newest title without its id, in the list and the detail", async () => {
    const tickets = await json<(Ticket & { title: string | null })[]>('/api/tickets');
    assert.equal(tickets.find(t => t.ticket?.toLowerCase() === 'ab-1')?.title, 'Stock limit');
    assert.equal(tickets.find(t => t.ticket === 'TOOL-search')?.title, null);
    const detail = await json<{ title: string | null }>('/api/tickets/AB-1');
    assert.equal(detail.title, 'Stock limit');
    assert.equal(titleWithoutTicket('AB-1', 'iOS crash on login'), 'iOS crash on login');
  });

  it('no longer serves topics', async () => {
    assert.equal((await fetch(`${base}/api/topics`)).status, 404);
  });

  it('filters runs by ticket, ignoring case, and by no ticket', async () => {
    const ids = async (ticket: string) =>
      (await json<{ id: string }[]>(`/api/runs?ticket=${encodeURIComponent(ticket)}`)).map(
        r => r.id,
      );
    assert.deepEqual(await ids('AB-1'), ['20260101000002-bbb', '20260101000001-aaa']);
    assert.deepEqual(await ids(''), ['20260101000005-eee', '20260101000004-ddd']);
    assert.equal(listRuns({ ticket: 'AB-1' }).length, 2);
  });

  it('leaves an old run its topic out of the run page', async () => {
    const detail = await json<{ run: Record<string, unknown> }>('/api/runs/20260101000004-ddd');
    assert.equal('topic' in detail.run, false);
    assert.equal('use_case_id' in detail.run, false);
  });
});

describe('report', () => {
  it('writes one run as Markdown under its label, without local evidence paths', () => {
    const md = buildReport({ runId: '20260101000001-aaa' })!;
    assert.match(md, /^# UI test: AB-1 run 1/);
    assert.match(md, /FAIL — \d{4}-\d{2}-\d{2}/);
    assert.match(md, /- ✓ no filter/);
    assert.match(md, /- ✕ legacy id/);
    assert.match(md, /store feat\/x@abc1234 \(\+local changes\)/);
    assert.doesNotMatch(md, /results\/runs/);
  });

  it('covers the latest runs of a ticket, newest first', () => {
    const md = buildReport({ ticket: 'ab-1', last: 2 })!;
    assert.match(md, /^# UI test: ab-1/);
    assert.ok(
      md.indexOf('## Latest: PASS') > 0 &&
        md.indexOf('## Earlier: FAIL') > md.indexOf('## Latest: PASS'),
    );
  });

  it('returns nothing for an unknown run or ticket', () => {
    assert.equal(buildReport({ runId: 'nope' }), undefined);
    assert.equal(buildReport({ ticket: 'NOPE-1' }), undefined);
  });
});
