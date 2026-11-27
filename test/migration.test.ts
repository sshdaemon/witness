import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { prose } from '../src/prose.js';

// A store made before branches and kinds were recorded.
const dir = mkdtempSync(join(tmpdir(), 'witness-migration-'));
process.env.WITNESS_RESULTS_DIR = dir;
const old = new DatabaseSync(join(dir, 'witness.sqlite'));
old.exec(
  `
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, use_case_id TEXT, env TEXT NOT NULL, run_tag TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT, verdict TEXT, summary TEXT,
      first_failure_step INTEGER, trace_path TEXT, step_log_path TEXT, client TEXT
    )
  `,
);
old.exec(
  `
    INSERT INTO runs (id, use_case_id, env, run_tag, started_at)
    VALUES ('r1', 'old-case', 'local', 'abc', '2025-01-01T00:00:00Z')
  `,
);
old.exec(
  `
    CREATE TABLE steps (
      run_id TEXT NOT NULL, seq INTEGER NOT NULL, tool TEXT NOT NULL, args_json TEXT,
      ok INTEGER NOT NULL, error_code TEXT, page_kind TEXT, url TEXT, duration_ms INTEGER,
      observation_json TEXT, screenshot_path TEXT, PRIMARY KEY (run_id, seq)
    )
  `,
);
old.exec(
  `
    CREATE TABLE artifacts (
      run_id TEXT NOT NULL, step_seq INTEGER, kind TEXT NOT NULL, path TEXT NOT NULL, bytes INTEGER
    )
  `,
);
old.exec(
  `
    INSERT INTO artifacts (run_id, step_seq, kind, path)
    VALUES ('r1', 1, 'screenshot', '/Users/x/work/witness/results/runs/r1/screenshots/a.png')
  `,
);
old.close();

const { store, listRuns, SCHEMA_VERSION } = await import('../src/mcp/store.js');

describe('older result store', () => {
  it(
    prose`
    gains the new columns and keeps its runs`,
    () => {
      const cols = new Set(
        (store().prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map(c => c.name),
      );
      for (const c of ['app_versions', 'topic', 'branch', 'kind']) assert.ok(cols.has(c), c);
      assert.deepEqual(
        listRuns({}).map(r => (r as { id: string }).id),
        ['r1'],
      );
    },
  );

  it(
    prose`
    stores paths relative to the results folder, drops the unused columns and records its version`,
    () => {
      store();
      const path = (store().prepare('SELECT path FROM artifacts').get() as { path: string }).path;
      assert.equal(path, 'runs/r1/screenshots/a.png');
      const names = (table: string) =>
        (store().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
          c => c.name,
        );
      for (const c of ['trace_path', 'step_log_path', 'client'])
        assert.ok(!names('runs').includes(c), c);
      assert.ok(!names('steps').includes('screenshot_path'));
      assert.ok(names('evidence').includes('posted_url'));
      assert.equal(
        (store().prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        SCHEMA_VERSION,
      );
    },
  );

  it('survives another process having added a column first', () => {
    const other = new DatabaseSync(join(dir, 'witness.sqlite'));
    assert.throws(() => other.exec('ALTER TABLE runs ADD COLUMN topic TEXT'), /duplicate column/i);
    other.close();
  });
});
