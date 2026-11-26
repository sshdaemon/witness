import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

// A version 2 store with case results recorded before they kept their environment.
const dir = mkdtempSync(join(tmpdir(), 'witness-migration-v3-'));
process.env.WITNESS_RESULTS_DIR = dir;
const old = new DatabaseSync(join(dir, 'witness.sqlite'));
old.exec(
  `
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, use_case_id TEXT, env TEXT NOT NULL, run_tag TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT, verdict TEXT, summary TEXT,
      first_failure_step INTEGER, app_versions TEXT, topic TEXT, branch TEXT, kind TEXT,
      ticket TEXT, label TEXT, run_number INTEGER, batch_id TEXT, lane INTEGER
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
    CREATE TABLE cases (
      ticket TEXT NOT NULL, case_id TEXT NOT NULL, title TEXT, steps_json TEXT, expected TEXT,
      needs_json TEXT, after_json TEXT, block_json TEXT, hash TEXT,
      regression INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
      PRIMARY KEY (ticket, case_id)
    );
    CREATE TABLE case_results (
      run_id TEXT NOT NULL, ticket TEXT NOT NULL, case_id TEXT NOT NULL, result TEXT NOT NULL,
      run_number INTEGER, actual TEXT, note TEXT, step_from INTEGER, step_to INTEGER,
      case_hash TEXT, judged_by TEXT NOT NULL, checks_result TEXT, checks_json TEXT,
      app_versions TEXT, finished_at TEXT NOT NULL,
      PRIMARY KEY (run_id, ticket, case_id)
    );
    CREATE TABLE ticket_runs (ticket TEXT PRIMARY KEY, last_run INTEGER NOT NULL);
    INSERT INTO runs (id, env, run_tag, started_at, ticket, run_number)
    VALUES ('r1', 'staging', 'abc', '2026-11-04T10:00:00Z', 'AB-5', 1);
    INSERT INTO case_results (run_id, ticket, case_id, result, run_number, judged_by, finished_at)
    VALUES ('r1', 'AB-5', 'C1', 'PASS', 1, 'checks', '2026-11-04T10:05:00Z'),
      ('gone', 'AB-5', 'C2', 'FAIL', 0, 'checks', '2026-10-01T10:05:00Z');
    PRAGMA user_version = 2;
  `,
);
old.close();

const { store } = await import('../src/mcp/store.js');
const { ticketCases } = await import('../src/mcp/cases.js');

describe('version 2 store', () => {
  it("gives each case result its run's environment", () => {
    const rows = store()
      .prepare('SELECT case_id, env FROM case_results ORDER BY case_id')
      .all() as { case_id: string; env: string | null }[];
    assert.deepEqual(
      rows.map(r => [r.case_id, r.env]),
      [
        ['C1', 'staging'],
        ['C2', null],
      ],
      'a result whose run is already gone has no environment to take',
    );
    const staging = ticketCases('AB-5', 'staging');
    assert.equal(staging.find(c => c.caseId === 'C1')?.latest?.result, 'PASS');
    assert.equal(
      ticketCases('AB-5', 'local').find(c => c.caseId === 'C1')?.latest ?? null,
      null,
      'nothing ran on local',
    );
  });
});
