import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

// A version 1 store as it is in use: runs without tickets, and the per-run cases and use_cases
// tables from before version 1 still there.
const dir = mkdtempSync(join(tmpdir(), 'witness-migration-v2-'));
process.env.WITNESS_RESULTS_DIR = dir;
const old = new DatabaseSync(join(dir, 'witness.sqlite'));
old.exec(
  `
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, use_case_id TEXT, env TEXT NOT NULL, run_tag TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT, verdict TEXT, summary TEXT,
      first_failure_step INTEGER, app_versions TEXT, topic TEXT, branch TEXT, kind TEXT
    );
    CREATE TABLE steps (
      run_id TEXT NOT NULL, seq INTEGER NOT NULL, tool TEXT NOT NULL, args_json TEXT,
      ok INTEGER NOT NULL, error_code TEXT, page_kind TEXT, url TEXT, duration_ms INTEGER,
      observation_json TEXT, PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE artifacts (
      run_id TEXT NOT NULL, step_seq INTEGER, kind TEXT NOT NULL, path TEXT NOT NULL, bytes INTEGER
    );
    CREATE TABLE evidence (
      id INTEGER PRIMARY KEY, ticket TEXT NOT NULL, case_id TEXT, caption TEXT NOT NULL,
      path TEXT NOT NULL, run_id TEXT NOT NULL, step_seq INTEGER NOT NULL, tool TEXT,
      source TEXT NOT NULL, created_at TEXT NOT NULL, posted_url TEXT, posted_at TEXT
    );
    CREATE TABLE use_cases (
      id TEXT PRIMARY KEY, title TEXT, path TEXT, content_hash TEXT, first_seen TEXT, last_seen TEXT
    );
    CREATE TABLE cases (
      run_id TEXT NOT NULL, seq INTEGER NOT NULL, title TEXT NOT NULL, steps_json TEXT NOT NULL,
      expected TEXT NOT NULL, result TEXT NOT NULL, actual TEXT, note TEXT,
      step_from INTEGER NOT NULL, step_to INTEGER NOT NULL, PRIMARY KEY (run_id, seq)
    );
    INSERT INTO runs (id, env, run_tag, started_at, verdict, topic)
    VALUES ('r1', 'staging', 'abc', '2026-10-20T00:00:00Z', 'PASS', 'AB-7 badges');
    INSERT INTO use_cases (id) VALUES ('old-case');
    PRAGMA user_version = 1;
  `,
);
old.close();

const { store, getRun, listRuns, SCHEMA_VERSION } = await import('../src/mcp/store.js');

const names = (table: string) =>
  (store().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);

describe('version 1 store', () => {
  it('gives runs a ticket, label, number, batch and lane, and keeps its runs', () => {
    for (const c of ['ticket', 'label', 'run_number', 'batch_id', 'lane'])
      assert.ok(names('runs').includes(c), c);
    assert.equal(
      (store().prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      SCHEMA_VERSION,
    );
    assert.deepEqual(
      listRuns({}).map(r => (r as { id: string }).id),
      ['r1'],
    );
    assert.deepEqual(getRun('r1')?.cases, []);
  });

  it('replaces the old per-run cases table and drops use_cases', () => {
    assert.ok(names('cases').includes('case_id'));
    assert.ok(!names('cases').includes('seq'));
    assert.deepEqual(names('use_cases'), []);
    for (const c of [
      'run_number',
      'env',
      'judged_by',
      'checks_result',
      'checks_json',
      'app_versions',
    ])
      assert.ok(names('case_results').includes(c), c);
    assert.ok(names('ticket_runs').includes('last_run'));
  });
});
