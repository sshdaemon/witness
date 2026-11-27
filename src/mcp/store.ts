import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, fromStored, RESULTS_DIR, runDir } from '../paths.js';

export { runDir };

export type Verdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'ABORTED';

export const CASE_RESULTS = ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'] as const;
export type CaseResult = (typeof CASE_RESULTS)[number];
export type JudgedBy = 'checks' | 'session';

/** One expect evaluated on a step's answer. */
export type Check = {
  seq: number;
  path: string;
  check: string;
  want?: unknown;
  got?: unknown;
  ok: boolean;
};

export type CaseResultRow = {
  run_id: string;
  ticket: string;
  case_id: string;
  run_number: number | null;
  result: CaseResult;
  actual: string | null;
  note: string | null;
  step_from: number | null;
  step_to: number | null;
  case_hash: string | null;
  judged_by: JudgedBy;
  checks_result: CaseResult | null;
  checks_json: string | null;
  app_versions: string | null;
  finished_at: string;
};

/**
 * Screenshots picked as a ticket's evidence: copies kept apart from the run, so they outlive its
 * retention.
 */
export const EVIDENCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY, ticket TEXT NOT NULL, case_id TEXT, caption TEXT NOT NULL,
  path TEXT NOT NULL, run_id TEXT NOT NULL, step_seq INTEGER NOT NULL, tool TEXT,
  source TEXT NOT NULL, created_at TEXT NOT NULL, posted_url TEXT, posted_at TEXT
);
CREATE INDEX IF NOT EXISTS evidence_ticket ON evidence (ticket);
`;

/**
 * A ticket's test cases, and each case's result in each run. Results keep their own copy of the
 * builds and run number, so they outlive the run's retention, and ticket_runs keeps each ticket's
 * last run number for the same reason.
 */
export const CASES_SCHEMA = `
CREATE TABLE IF NOT EXISTS cases (
  ticket TEXT NOT NULL, case_id TEXT NOT NULL, title TEXT, steps_json TEXT, expected TEXT,
  needs_json TEXT, after_json TEXT, block_json TEXT, hash TEXT,
  regression INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  PRIMARY KEY (ticket, case_id)
);
CREATE TABLE IF NOT EXISTS case_results (
  run_id TEXT NOT NULL, ticket TEXT NOT NULL, case_id TEXT NOT NULL, result TEXT NOT NULL,
  run_number INTEGER, env TEXT, actual TEXT, note TEXT, step_from INTEGER, step_to INTEGER,
  case_hash TEXT,
  judged_by TEXT NOT NULL, checks_result TEXT, checks_json TEXT, app_versions TEXT,
  finished_at TEXT NOT NULL,
  PRIMARY KEY (run_id, ticket, case_id)
);
CREATE INDEX IF NOT EXISTS case_results_case ON case_results (ticket, case_id);
CREATE TABLE IF NOT EXISTS ticket_runs (ticket TEXT PRIMARY KEY, last_run INTEGER NOT NULL);
`;

/** Made after the migration, as an older runs table has no ticket column until then. */
const RUNS_INDEX = 'CREATE INDEX IF NOT EXISTS runs_ticket ON runs (ticket, run_number);';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, use_case_id TEXT, env TEXT NOT NULL, run_tag TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT, verdict TEXT, summary TEXT,
  first_failure_step INTEGER, app_versions TEXT, topic TEXT, branch TEXT, kind TEXT,
  ticket TEXT, label TEXT, run_number INTEGER, batch_id TEXT, lane INTEGER
);
CREATE TABLE IF NOT EXISTS steps (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, tool TEXT NOT NULL, args_json TEXT,
  ok INTEGER NOT NULL, error_code TEXT, page_kind TEXT, url TEXT, duration_ms INTEGER,
  observation_json TEXT,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS artifacts (
  run_id TEXT NOT NULL, step_seq INTEGER, kind TEXT NOT NULL, path TEXT NOT NULL, bytes INTEGER
);
${EVIDENCE_SCHEMA}
`;

/** Bumped with every migration below; PRAGMA user_version records how far a store has come. */
export const SCHEMA_VERSION = 3;

const columns = (d: DatabaseSync, table: string) =>
  (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);

// v1: paths relative to the results folder, the unused trace, step log, client and per-step
// screenshot columns gone, and the evidence table.
function migrate(d: DatabaseSync, from: number) {
  if (from < 1) {
    const cols = new Set(
      (d.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map(c => c.name),
    );
    for (const col of ['app_versions', 'topic', 'branch', 'kind']) {
      if (!cols.has(col)) d.exec(`ALTER TABLE runs ADD COLUMN ${col} TEXT`);
    }
    // Absolute paths from before, such as
    // /Users/x/work/app-mcp/results/runs/<id>/screenshots/a.png Cut at the row's own run
    // folder, so a results folder whose own path holds /runs/ is not cut short.
    d.exec(
      `
        UPDATE artifacts SET path = substr(path, instr(path, '/runs/' || run_id || '/') + 1)
        WHERE path LIKE '/%' AND instr(path, '/runs/' || run_id || '/') > 0
      `,
    );
    for (const [table, col] of [
      ['runs', 'trace_path'],
      ['runs', 'step_log_path'],
      ['runs', 'client'],
      ['steps', 'screenshot_path'],
    ] as const) {
      const has = (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
        c => c.name === col,
      );
      if (has) d.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`);
    }
    d.exec(EVIDENCE_SCHEMA);
  }
  // v2: runs know their ticket, label and number, and cases and their results get tables. The
  // per-run cases table and use_cases from before v1 were never read by the code.
  if (from < 2) {
    const have = columns(d, 'runs');
    for (const [col, type] of [
      ['ticket', 'TEXT'],
      ['label', 'TEXT'],
      ['run_number', 'INTEGER'],
      ['batch_id', 'TEXT'],
      ['lane', 'INTEGER'],
    ] as const) {
      if (!have.includes(col)) d.exec(`ALTER TABLE runs ADD COLUMN ${col} ${type}`);
    }
    if (columns(d, 'cases').includes('seq')) d.exec('DROP TABLE cases');
    d.exec('DROP TABLE IF EXISTS use_cases');
    d.exec(CASES_SCHEMA);
  }
  // v3: case results keep the environment they ran in, so it outlives the run's retention.
  if (from < 3) {
    if (!columns(d, 'case_results').includes('env'))
      d.exec('ALTER TABLE case_results ADD COLUMN env TEXT');
    d.exec(
      `
        UPDATE case_results SET env = (SELECT env FROM runs WHERE runs.id = case_results.run_id)
        WHERE env IS NULL
      `,
    );
  }
}

/**
 * SQLite's own LOWER only folds ASCII, so tickets are compared with the same toLowerCase the viewer
 * groups them by.
 */
export function registerFunctions(d: DatabaseSync) {
  d.function('ulower', { deterministic: true }, v =>
    v == null ? null : String(v).trim().toLowerCase(),
  );
}

let db: DatabaseSync | undefined;

export function store(): DatabaseSync {
  if (!db) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const d = new DatabaseSync(DB_PATH);
    d.exec('PRAGMA journal_mode = WAL');
    d.exec('PRAGMA busy_timeout = 5000');
    registerFunctions(d);
    // Several server processes share the store, so one of them migrates and the others wait for it.
    d.exec('BEGIN IMMEDIATE');
    try {
      const fresh = !d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'runs'").get();
      const version = (d.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version;
      if (fresh) d.exec(SCHEMA + CASES_SCHEMA);
      else if (version < SCHEMA_VERSION) {
        // Tables an older store never had are made as they are now; the ones it has are brought up
        // to date. The cases tables wait for the migration, which first drops an older cases.
        d.exec(SCHEMA.replace(/CREATE TABLE IF NOT EXISTS runs[^;]*;/, ''));
        migrate(d, version);
      }
      d.exec(RUNS_INDEX);
      if (fresh || version < SCHEMA_VERSION) d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      d.exec('COMMIT');
    } catch (e) {
      d.exec('ROLLBACK');
      throw e;
    }
    db = d;
  }
  return db;
}

/** Closes the store, so SQLite folds its write-ahead log back in before the process exits. */
export function closeStore() {
  db?.close();
  db = undefined;
}

export type StepRow = {
  run_id: string;
  seq: number;
  tool: string;
  args_json: string;
  ok: number;
  error_code: string | null;
  page_kind: string | null;
  url: string | null;
  duration_ms: number;
  observation_json: string | null;
};

export function listRuns(filter: {
  ticket?: string;
  env?: string;
  verdict?: string;
  limit?: number;
}) {
  const where: string[] = [];
  const params: Record<string, string | number> = { limit: Math.min(filter.limit ?? 20, 100) };
  if (filter.ticket) {
    where.push('ulower(ticket) = ulower(:ticket)');
    params.ticket = filter.ticket;
  }
  if (filter.env) {
    where.push('env = :env');
    params.env = filter.env;
  }
  if (filter.verdict) {
    where.push('verdict = :verdict');
    params.verdict = filter.verdict;
  }
  const sql = `
    SELECT id, ticket, run_number, label, branch, env, run_tag, started_at, finished_at, verdict,
      summary, first_failure_step
    FROM runs ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY started_at DESC, id DESC
    LIMIT :limit
  `;
  return store().prepare(sql).all(params);
}

export function caseResultsFor(runId: string) {
  return (
    store()
      .prepare('SELECT * FROM case_results WHERE run_id = ? ORDER BY step_from IS NULL, step_from')
      .all(runId) as CaseResultRow[]
  ).map(r => ({
    ticket: r.ticket,
    caseId: r.case_id,
    runNumber: r.run_number,
    result: r.result,
    actual: r.actual,
    note: r.note,
    steps: r.step_from == null ? null : { from: r.step_from, to: r.step_to },
    judgedBy: r.judged_by,
    checksResult: r.checks_result,
    checks: r.checks_json ? (JSON.parse(r.checks_json) as Check[]) : [],
  }));
}

export function getRun(id: string, opts: { limit?: number; offset?: number } = {}) {
  const run = store().prepare('SELECT * FROM runs WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!run) return null;
  const steps = store()
    .prepare(
      `
        SELECT seq, tool, substr(args_json, 1, 500) AS args_json, ok, error_code, page_kind,
          url, duration_ms
        FROM steps WHERE run_id = ?
        ORDER BY seq LIMIT ? OFFSET ?
      `,
    )
    .all(id, Math.min(opts.limit ?? 50, 200), opts.offset ?? 0);
  const artifacts = (
    store()
      .prepare('SELECT step_seq, kind, path, bytes FROM artifacts WHERE run_id = ?')
      .all(id) as {
      path: string;
    }[]
  ).map(a => ({ ...a, path: fromStored(a.path) }));
  return { run: { ...run, dir: runDir(id) }, steps, artifacts, cases: caseResultsFor(id) };
}
