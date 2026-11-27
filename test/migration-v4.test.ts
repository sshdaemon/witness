import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

// A version 3 store, from when runs carried a topic: usually the ticket id and its title.
const dir = mkdtempSync(join(tmpdir(), 'witness-migration-v4-'));
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
      app_versions TEXT, finished_at TEXT NOT NULL, env TEXT,
      PRIMARY KEY (run_id, ticket, case_id)
    );
    CREATE TABLE ticket_runs (ticket TEXT PRIMARY KEY, last_run INTEGER NOT NULL);
    INSERT INTO runs (id, env, run_tag, started_at, ticket, topic) VALUES
      ('r1', 'local', 'a', '2026-11-01T10:00:00Z', 'AB-5', 'AB-5 old wording'),
      ('r2', 'local', 'b', '2026-11-02T10:00:00Z', 'ab-5', 'ab-5: stock limit on the page'),
      ('r3', 'local', 'c', '2026-11-03T10:00:00Z', 'AB-5', '  '),
      ('r4', 'local', 'd', '2026-11-03T10:00:00Z', 'AB-6', 'Regression: search'),
      ('r5', 'local', 'e', '2026-11-03T10:00:00Z', 'AB-7', 'AB-7'),
      ('r6', 'local', 'f', '2026-11-03T10:00:00Z', NULL, 'No ticket at all');
    PRAGMA user_version = 3;
  `,
);
old.close();

const { store } = await import('../src/mcp/store.js');

describe('version 3 store', () => {
  it("gives each ticket its newest topic as its title, without the ticket's id", () => {
    const rows = store()
      .prepare('SELECT ticket, title FROM ticket_titles ORDER BY ticket')
      .all() as { ticket: string; title: string }[];
    assert.deepEqual(
      rows.map(r => [r.ticket.toUpperCase(), r.title]),
      [
        ['AB-5', 'Stock limit on the page'],
        ['AB-6', 'Regression: search'],
      ],
    );
  });
});
