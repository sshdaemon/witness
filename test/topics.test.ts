import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { prose } from '../src/prose.js';

// The store reads its folder at import time, so point it at a throwaway one first.
process.env.WITNESS_RESULTS_DIR = mkdtempSync(join(tmpdir(), 'witness-topics-'));

const { Recorder } = await import('../src/mcp/recorder.js');
const { buildReport } = await import('../src/mcp/report.js');
const { listRuns, store } = await import('../src/mcp/store.js');
const { createViewer } = await import('../src/ui/server.js');

const builds = { store: { branch: 'feat/x', sha: 'abc1234', dirty: true } };
const run = (
  id: string,
  about: { topic?: string; branch?: string },
  verdict?: 'PASS' | 'FAIL',
  summary = '',
) => {
  const r = new Recorder(id, 'local', id.slice(-3), about, builds);
  if (verdict) r.finish(verdict, summary);
  return r;
};

run(
  '20260101000001-aaa',
  { topic: 'SALE filter on store dashboard', branch: 'feat/x' },
  'FAIL',
  'ok: no filter; FAIL: legacy id',
);
run(
  '20260101000002-bbb',
  { topic: 'sale filter on store dashboard ', branch: 'feat/x' },
  'PASS',
  'ok: no filter; ok: legacy id',
);
run('20260101000003-ccc', {}, 'PASS', 'badge shown');
// An older run recorded only a use-case slug.
store()
  .prepare('UPDATE runs SET use_case_id = ? WHERE id = ?')
  .run('made-up-case-for-test', '20260101000003-ccc');
run('20260101000004-ddd', {});
run('20260101000005-eee', { topic: 'École Primaire' }, 'PASS');
run('20260101000006-fff', { topic: ' ÉCOLE primaire' }, 'FAIL');

describe('topics', () => {
  let server: Server;
  let base: string;
  before(async () => {
    server = createViewer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it(
    prose`
    groups runs by topic ignoring case and spacing, newest run is the latest result`,
    async () => {
      const topics = (await (await fetch(`${base}/api/topics`)).json()) as {
        key: string;
        title: string;
        runs: number;
        latest: { verdict: string };
        branch: string | null;
      }[];
      const sale = topics.find(t => t.key === 'sale filter on store dashboard');
      assert.equal(sale?.runs, 2);
      assert.equal(sale?.latest.verdict, 'PASS');
      assert.equal(sale?.branch, 'feat/x');
      assert.equal(
        topics.find(t => t.key === 'made-up-case-for-test')?.title,
        'Made up case for test',
      );
      assert.equal(topics.find(t => t.key === '')?.title, 'Untitled runs');
    },
  );

  it('filters runs by topic, including the untitled ones', async () => {
    const ids = async (topic: string) =>
      (
        (await (await fetch(`${base}/api/runs?topic=${encodeURIComponent(topic)}`)).json()) as {
          id: string;
        }[]
      ).map(r => r.id);
    assert.deepEqual(await ids('SALE filter on store dashboard'), [
      '20260101000002-bbb',
      '20260101000001-aaa',
    ]);
    assert.deepEqual(await ids(''), ['20260101000004-ddd']);
  });

  it('treats non-ASCII capitals as the same topic in the list and in the filter', async () => {
    const topics = (await (await fetch(`${base}/api/topics`)).json()) as {
      key: string;
      runs: number;
    }[];
    const school = topics.find(t => t.key === 'école primaire');
    assert.equal(school?.runs, 2);
    const filtered = (await (
      await fetch(`${base}/api/runs?topic=${encodeURIComponent('école primaire')}`)
    ).json()) as unknown[];
    assert.equal(filtered.length, 2);
    assert.equal(listRuns({ topic: 'ÉCOLE PRIMAIRE' }).length, 2);
  });

  it('titles an older slug-only run on its run page and in a report', async () => {
    const detail = (await (await fetch(`${base}/api/runs/20260101000003-ccc`)).json()) as {
      run: { topic: string };
    };
    assert.equal(detail.run.topic, 'Made up case for test');
    assert.match(
      buildReport({ runId: '20260101000003-ccc' })!,
      /^# UI test: Made up case for test/,
    );
  });

  it('lists runs for a topic through the tool query too', () => {
    assert.equal(listRuns({ topic: 'SALE FILTER ON STORE DASHBOARD' }).length, 2);
  });
});

describe('report', () => {
  it('writes one run as Markdown without local evidence paths', () => {
    const md = buildReport({ runId: '20260101000001-aaa' })!;
    assert.match(md, /^# UI test: SALE filter on store dashboard/);
    assert.match(md, /FAIL — \d{4}-\d{2}-\d{2}/);
    assert.match(md, /- ✓ no filter/);
    assert.match(md, /- ✕ legacy id/);
    assert.match(md, /store feat\/x@abc1234 \(\+local changes\)/);
    assert.doesNotMatch(md, /results\/runs/);
  });

  it('covers the latest runs of a topic, newest first', () => {
    const md = buildReport({ topic: 'sale filter on store dashboard', last: 2 })!;
    assert.ok(
      md.indexOf('## Latest: PASS') > 0 &&
        md.indexOf('## Earlier: FAIL') > md.indexOf('## Latest: PASS'),
    );
  });

  it('returns nothing for an unknown run or topic', () => {
    assert.equal(buildReport({ runId: 'nope' }), undefined);
    assert.equal(buildReport({ topic: 'nothing here' }), undefined);
  });
});
