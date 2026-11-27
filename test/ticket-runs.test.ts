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
const { listRuns, store } = await import('../src/mcp/store.js');
const { createViewer } = await import('../src/ui/server.js');

const builds = { store: { branch: 'feat/x', sha: 'abc1234', dirty: true } };
const run = (
  id: string,
  about: { ticket?: string; branch?: string; kind?: string },
  verdict?: 'PASS' | 'FAIL',
  summary = '',
) => {
  const r = new Recorder(id, 'local', id.slice(-3), about, builds);
  if (verdict) r.finish(verdict, summary);
  return r;
};

run(
  '20260101000001-aaa',
  { ticket: 'AB-1', branch: 'feat/x' },
  'FAIL',
  'ok: no filter; FAIL: legacy id',
);
run(
  '20260101000002-bbb',
  { ticket: 'ab-1', branch: 'feat/x' },
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
