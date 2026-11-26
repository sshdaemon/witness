import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { prose } from '../src/prose.js';

// The store reads its folder at import time, so point it at a throwaway one first.
const dir = mkdtempSync(join(tmpdir(), 'witness-retention-'));
process.env.WITNESS_RESULTS_DIR = dir;

const { store } = await import('../src/mcp/store.js');
const { pruneOldRuns, retentionDays, startedFromName, sweepAbandonedRuns, toolRetentionDays } =
  await import('../src/mcp/retention.js');

const now = new Date('2026-10-15T12:00:00Z');
const run = (
  id: string,
  startedAt: string,
  finishedAt: string | null = startedAt,
  lastWrite = new Date(startedAt),
) => {
  store()
    .prepare(
      `
        INSERT INTO runs (id, env, run_tag, started_at, finished_at)
        VALUES (?, 'staging', 't', ?, ?)
      `,
    )
    .run(id, startedAt, finishedAt);
  store().prepare("INSERT INTO steps (run_id, seq, tool, ok) VALUES (?, 1, 'login', 1)").run(id);
  store()
    .prepare("INSERT INTO artifacts (run_id, kind, path) VALUES (?, 'screenshot', 'x.png')")
    .run(id);
  mkdirSync(join(dir, 'runs', id, 'screenshots'), { recursive: true });
  writeFileSync(join(dir, 'runs', id, 'screenshots', 'verify-1.png'), 'png');
  writeFileSync(join(dir, 'runs', id, 'steps.jsonl'), '{}\n');
  utimesSync(join(dir, 'runs', id, 'steps.jsonl'), lastWrite, lastWrite);
  utimesSync(join(dir, 'runs', id), lastWrite, lastWrite);
};
const count = (table: string, id: string) =>
  (
    store()
      .prepare(`
        SELECT COUNT(*) AS n FROM ${table} WHERE ${table === 'runs' ? 'id' : 'run_id'} = ?
      `)
      .get(id) as { n: number }
  ).n;

describe('retention', () => {
  it('reads the days from the environment, falling back to 14', () => {
    assert.equal(retentionDays(undefined), 14);
    assert.equal(retentionDays('7'), 7);
    assert.equal(retentionDays('0'), 14);
    assert.equal(retentionDays('abc'), 14);
    assert.equal(retentionDays('2.5'), 14);
  });

  it("reads a run folder's start time as UTC and ignores other names", () => {
    assert.equal(
      startedFromName('20261015115334-e96f94')?.toISOString(),
      '2026-10-15T11:53:34.000Z',
    );
    assert.equal(startedFromName('notes'), undefined);
    assert.equal(startedFromName('20261015115334'), undefined);
  });

  it('removes runs older than the limit with their rows and files, and keeps newer ones', () => {
    run('20260930115959-old1', '2026-09-30T11:59:59.000Z');
    run('20261001120001-new1', '2026-10-01T12:00:01.000Z');
    // Started long ago but still recording in another server process.
    run('20260901000000-open1', '2026-09-01T00:00:00.000Z', null, new Date('2026-10-15T11:00:00Z'));
    // Started long ago, never finished, silent since: a crashed run.
    run('20260902000000-dead1', '2026-09-02T00:00:00.000Z', null, new Date('2026-09-02T01:00:00Z'));
    mkdirSync(join(dir, 'runs', '20260901000000-orphan'), { recursive: true });
    utimesSync(
      join(dir, 'runs', '20260901000000-orphan'),
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-09-01T00:00:00Z'),
    );
    mkdirSync(join(dir, 'runs', '20261014000000-orphan2'), { recursive: true });
    mkdirSync(join(dir, 'runs', 'keep-me'), { recursive: true });

    const removed = pruneOldRuns(now, 14);

    assert.deepEqual(removed.runs.toSorted(), ['20260902000000-dead1', '20260930115959-old1']);
    assert.deepEqual(removed.folders.toSorted(), [
      '20260901000000-orphan',
      '20260902000000-dead1',
      '20260930115959-old1',
    ]);
    assert.equal(count('runs', '20260901000000-open1'), 1);
    assert.ok(existsSync(join(dir, 'runs', '20260901000000-open1', 'steps.jsonl')));
    for (const table of ['runs', 'steps', 'artifacts'])
      assert.equal(count(table, '20260930115959-old1'), 0);
    assert.equal(existsSync(join(dir, 'runs', '20260930115959-old1')), false);
    assert.equal(count('runs', '20261001120001-new1'), 1);
    assert.equal(count('steps', '20261001120001-new1'), 1);
    assert.ok(existsSync(join(dir, 'runs', '20261001120001-new1', 'screenshots', 'verify-1.png')));
    assert.ok(existsSync(join(dir, 'runs', '20261014000000-orphan2')));
    assert.ok(existsSync(join(dir, 'runs', 'keep-me')));
  });

  it('does nothing when everything is recent', () =>
    assert.deepEqual(pruneOldRuns(now, 14), { runs: [], folders: [] }));

  it('keeps runs made to exercise a tool for a shorter time', () => {
    assert.equal(toolRetentionDays(undefined), 3);
    assert.equal(toolRetentionDays('30'), 14);
    run('20261011000000-tool1', '2026-10-11T00:00:00.000Z');
    run('20261013000000-tool2', '2026-10-13T00:00:00.000Z');
    run('20261011000000-test1', '2026-10-11T00:00:00.000Z');
    store()
      .prepare(
        `
          UPDATE runs SET kind = 'tool'
          WHERE id IN ('20261011000000-tool1', '20261013000000-tool2')
        `,
      )
      .run();
    assert.deepEqual(pruneOldRuns(now, 14, 3).runs, ['20261011000000-tool1']);
    assert.equal(count('runs', '20261013000000-tool2'), 1);
    assert.equal(count('runs', '20261011000000-test1'), 1);
  });

  it(
    prose`
    records runs left open by a server that is gone as ABORTED, and leaves live ones open`,
    () => {
      run(
        '20261015000000-gone1',
        '2026-10-15T00:00:00.000Z',
        null,
        new Date('2026-10-15T01:00:00Z'),
      );
      run(
        '20261015110000-live1',
        '2026-10-15T11:00:00.000Z',
        null,
        new Date('2026-10-15T11:50:00Z'),
      );
      assert.deepEqual(sweepAbandonedRuns(now), ['20261015000000-gone1']);
      const verdict = (id: string) =>
        (
          store().prepare('SELECT verdict FROM runs WHERE id = ?').get(id) as {
            verdict: string | null;
          }
        ).verdict;
      assert.equal(verdict('20261015000000-gone1'), 'ABORTED');
      assert.equal(verdict('20261015110000-live1'), null);
    },
  );
});
