// The one way to read the results store: the viewer, report and the read CLI go through it, so
// the tables can change behind it. See docs/read-contract.md.
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, EVIDENCE_DIR, fromStored, runDir } from '../paths.js';
import { registerFunctions, verdictOfResults } from '../mcp/store.js';
import { buildMap, otherBuild } from '../runner/missing.js';
import type { LedgerResult, LedgerRun } from '../ledger/qaMd.js';

// Read-only on purpose: the viewer can never alter a run.
let db: DatabaseSync | undefined;
const database = () => {
  if (!existsSync(DB_PATH)) return undefined;
  if (!db) {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    registerFunctions(db);
  }
  return db;
};

// A store written before some columns existed must still be readable, and the viewer must not alter
// it.
type Cols = Set<string>;
const columns = (d: DatabaseSync): Cols =>
  new Set((d.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map(c => c.name));
const col = (cols: Cols, name: string, prefix = '') =>
  cols.has(name) ? `${prefix}${name}` : `NULL AS ${name}`;
/** What runs() filters on; a ticket of '' means runs without one. */
export type RunFilter = {
  ticket?: string | null;
  env?: string | null;
  verdict?: string | null;
  limit?: number | string | null;
};

/** Runs, newest first, up to limit (50 by default, at most 200). */
export function runs(q: RunFilter = {}) {
  const d = database();
  if (!d) return [];
  const cols = columns(d);
  const where: string[] = [];
  const params: Record<string, string | number> = {
    limit: Math.min(Math.max(Math.trunc(Number(q.limit)) || 50, 1), 200),
  };
  const ticket = q.ticket ?? null;
  if (ticket !== null && cols.has('ticket')) {
    where.push(`ulower(COALESCE(r.ticket, '')) = ulower(:ticket)`);
    params.ticket = ticket;
  }
  for (const [key, name] of [
    ['env', 'env'],
    ['verdict', 'verdict'],
  ] as const) {
    const v = q[key];
    if (v) {
      where.push(`r.${name} = :${key}`);
      params[key] = v;
    }
  }
  const sql = `
    SELECT r.id, ${col(cols, 'branch', 'r.')}, r.env, ${col(cols, 'kind', 'r.')},
      ${col(cols, 'ticket', 'r.')}, ${col(cols, 'run_number', 'r.')}, ${col(cols, 'label', 'r.')},
      ${col(cols, 'lane', 'r.')},
      r.run_tag, r.started_at, r.finished_at, r.verdict, r.summary, r.first_failure_step,
      ${col(cols, 'app_versions', 'r.')},
      (SELECT COUNT(*) FROM steps s WHERE s.run_id = r.id) AS steps,
      (SELECT COUNT(*) FROM steps s WHERE s.run_id = r.id AND s.ok = 0) AS failed_steps
    FROM runs r ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY r.started_at DESC, r.id DESC
    LIMIT :limit
  `;
  return (d.prepare(sql).all(params) as Record<string, unknown>[]).map(r => ({
    ...r,
    app_versions: parse(r.app_versions as string | null),
  }));
}

const parse = (text: string | null) => {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * How a reader is pointed at files: the viewer gives URLs it serves, the CLI absolute paths (the
 * default).
 */
export type Links = {
  shot: (runId: string, name: string) => string;
  evidence: (row: { id: number; path: string }) => string;
};
const FILES: Links = {
  shot: (runId, name) => resolve(runDir(runId), 'screenshots', name),
  evidence: row => fromStored(row.path),
};

/**
 * A run with its cases, artifacts, sibling lanes and steps: the first 500, or the steps numbered
 * from..to.
 */
export function runDetail(
  id: string,
  opts: { links?: Links; steps?: { from?: number; to?: number } } = {},
) {
  const links = opts.links ?? FILES;
  const d = database();
  const run = d?.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!d || !run) return undefined;
  const steps = (
    (opts.steps
      ? d
          .prepare('SELECT * FROM steps WHERE run_id = ? AND seq BETWEEN ? AND ? ORDER BY seq')
          .all(id, opts.steps.from ?? 0, opts.steps.to ?? Number.MAX_SAFE_INTEGER)
      : d.prepare('SELECT * FROM steps WHERE run_id = ? ORDER BY seq LIMIT 500').all(id)) as Record<
      string,
      unknown
    >[]
  ).map(s => ({
    seq: s.seq,
    tool: s.tool,
    args: parse(s.args_json as string),
    ok: s.ok === 1,
    errorCode: s.error_code,
    pageKind: s.page_kind,
    url: s.url,
    durationMs: s.duration_ms,
    observation: parse(s.observation_json as string | null),
    screenshot: s.screenshot_path ? links.shot(id, basename(s.screenshot_path as string)) : null,
    screenshots: [] as string[],
  }));
  // A step can carry several frames; the artifacts keep them in the order they were taken.
  for (const a of d
    .prepare(
      `
        SELECT step_seq, path FROM artifacts
        WHERE run_id = ? AND kind = 'screenshot' AND step_seq IS NOT NULL
        ORDER BY rowid
      `,
    )
    .all(id) as { step_seq: number; path: string }[]) {
    steps.find(s => s.seq === a.step_seq)?.screenshots.push(links.shot(id, basename(a.path)));
  }
  const artifacts = (
    d.prepare('SELECT step_seq, kind, path, bytes FROM artifacts WHERE run_id = ?').all(id) as {
      step_seq: number | null;
      kind: string;
      path: string;
      bytes: number | null;
    }[]
  ).map(a => ({
    stepSeq: a.step_seq,
    kind: a.kind,
    bytes: a.bytes,
    name: basename(a.path),
    // Traces and logs are never served: they can hold credentials. Only the way to open them is
    // shown.
    openWith:
      a.kind === 'trace' ? `npx playwright show-trace "${fromStored(a.path)}"` : fromStored(a.path),
    url: a.kind === 'screenshot' ? links.shot(id, basename(a.path)) : null,
  }));
  const cases = hasTable(d, 'case_results')
    ? (
        d
          .prepare(
            `
              SELECT * FROM case_results WHERE run_id = ?
              ORDER BY step_from IS NULL, step_from, case_id
            `,
          )
          .all(id) as ResultRow[]
      ).map(r => ({ ticket: r.ticket, caseId: r.case_id, ...caseResult(r) }))
    : [];
  const { topic: _topic, use_case_id: _useCase, ...own } = run;
  return {
    run: {
      ...own,
      app_versions: parse(run.app_versions as string | null),
    },
    steps,
    artifacts,
    cases,
    // The other lanes of the batch this run ran in, if it did.
    lanes:
      typeof run.batch_id === 'string'
        ? (d
            .prepare('SELECT id, lane, verdict FROM runs WHERE batch_id = ? ORDER BY lane, id')
            .all(run.batch_id) as { id: string; lane: number | null; verdict: string | null }[])
        : [],
  };
}

const hasTable = (d: DatabaseSync, name: string) =>
  !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

type ResultRow = {
  run_id: string;
  ticket: string;
  case_id: string;
  run_number: number | null;
  result: string;
  actual: string | null;
  note: string | null;
  step_from: number | null;
  step_to: number | null;
  judged_by: string;
  case_hash: string | null;
  checks_result: string | null;
  checks_json: string | null;
  app_versions: string | null;
  finished_at: string;
};

type TicketRun = {
  id: string;
  run_number: number | null;
  label: string | null;
  started_at: string | null;
  verdict: string | null;
  env: string | null;
  app_versions: string | null;
  lane: number | null;
  batch_id: string | null;
  pruned: boolean;
};

/** The worst verdict among a batch's lanes: one failing lane fails the batch. */
const VERDICT_RANK = ['FAIL', 'BLOCKED', 'ABORTED', null, 'PASS'];
const worst = (verdicts: (string | null)[]) =>
  verdicts.toSorted((a, b) => VERDICT_RANK.indexOf(a) - VERDICT_RANK.indexOf(b))[0] ?? null;

/** Case ids in the order people number them: C2 before C10. */
const byCaseId = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/** Which commit served each app in a run, with "+" for local changes. */
const buildOf = (appVersions: string | null) => buildMap(parse(appVersions));

const caseResult = (r: ResultRow) => ({
  runId: r.run_id,
  runNumber: r.run_number,
  result: r.result,
  actual: r.actual,
  note: r.note,
  steps: r.step_from == null ? null : { from: r.step_from, to: r.step_to },
  judgedBy: r.judged_by,
  checksResult: r.checks_result,
  checks: (parse(r.checks_json) as unknown[] | null) ?? [],
  finishedAt: r.finished_at,
});

/** Each ticket's title, by its lower-cased id. */
const titles = (d: DatabaseSync) =>
  new Map(
    hasTable(d, 'ticket_titles')
      ? (
          d.prepare('SELECT ticket, title FROM ticket_titles').all() as {
            ticket: string;
            title: string;
          }[]
        ).map(t => [t.ticket.toLowerCase(), t.title])
      : [],
  );

/**
 * Every ticket with runs or case results, the most recently tested first. Runs from before every
 * run had a ticket come together in one entry whose ticket is null.
 */
export function tickets() {
  const d = database();
  if (!d || !hasTable(d, 'case_results') || !columns(d).has('ticket')) return [];
  const cols = columns(d);
  const results = d.prepare('SELECT * FROM case_results ORDER BY finished_at').all() as ResultRow[];
  const runRows = d
    .prepare(
      `
        SELECT id, ticket, started_at, verdict, ${col(cols, 'kind')}, run_number FROM runs
        ORDER BY started_at
      `,
    )
    .all() as {
    id: string;
    ticket: string | null;
    started_at: string;
    verdict: string | null;
    kind: string | null;
    run_number: number | null;
  }[];
  type Entry = {
    ticket: string | null;
    runs: Set<string>;
    latest: string;
    /** The newest run, its lanes taken together: its number (or id) and its lanes' verdicts. */
    lastRun: string;
    lastVerdicts: (string | null)[];
    tool: boolean;
    current: Map<string, ResultRow>;
    /** Whether any of its runs is still in the store; retention removes old ones. */
    kept: boolean;
    /** With every run removed: the newest run's key and its cases' results. */
    lastResultRun: string;
    lastResults: string[];
  };
  const byKey = new Map<string, Entry>();
  const entry = (ticket: string | null) => {
    const key = ticket?.toLowerCase() ?? '';
    let e = byKey.get(key);
    if (!e)
      byKey.set(
        key,
        (e = {
          ticket,
          runs: new Set(),
          latest: '',
          lastRun: '',
          lastVerdicts: [],
          tool: true,
          current: new Map(),
          kept: false,
          lastResultRun: '',
          lastResults: [],
        }),
      );
    return e;
  };
  for (const r of runRows) {
    const e = entry(r.ticket);
    e.runs.add(r.id);
    // Ordered by start, so the last run wins; the lanes of a batch share its number.
    const key = r.run_number == null ? r.id : `#${r.run_number}`;
    if (key !== e.lastRun) [e.lastRun, e.lastVerdicts] = [key, []];
    e.lastVerdicts.push(r.verdict);
    e.kept = true;
    if (r.kind !== 'tool') e.tool = false;
    if (r.started_at > e.latest) e.latest = r.started_at;
  }
  for (const r of results) {
    const e = entry(r.ticket);
    e.runs.add(r.run_id);
    if (r.finished_at > e.latest) e.latest = r.finished_at;
    e.current.set(r.case_id, r); // ordered by time, so the last one wins
    // Ordered by time, so the newest run's results come last.
    const run = r.run_number == null ? r.run_id : `#${r.run_number}`;
    if (run !== e.lastResultRun) [e.lastResultRun, e.lastResults] = [run, []];
    e.lastResults.push(r.result);
  }
  const titleOf = titles(d);
  return [...byKey.values()]
    .map(e => {
      const counts: Record<string, number> = {};
      for (const r of e.current.values()) counts[r.result] = (counts[r.result] ?? 0) + 1;
      return {
        ticket: e.ticket,
        title: e.ticket === null ? null : (titleOf.get(e.ticket.toLowerCase()) ?? null),
        runs: e.runs.size,
        cases: e.current.size,
        counts,
        latest: e.latest,
        // One failing lane fails the run; with every run removed, its cases give the verdict.
        verdict: e.kept ? worst(e.lastVerdicts) : (verdictOfResults(e.lastResults) ?? null),
        tool: e.tool && e.current.size === 0,
      };
    })
    .toSorted((a, b) => b.latest.localeCompare(a.latest));
}

// The lanes of a batch are one column: each case ran in one of them. Removed lanes lost their
// batch, so they come together by run number.
const columnOf = (r: TicketRun) =>
  r.batch_id ?? (r.pruned && r.run_number != null ? `removed-${r.run_number}` : r.id);

/**
 * A ticket's cases against its runs: each cell is the case's result in that run, and current is
 * its latest result, flagged when that ran on other builds than the ticket's newest run.
 */
export function ticketDetail(ticket: string) {
  const d = database();
  if (!d || !hasTable(d, 'case_results')) return undefined;
  const cols = columns(d);
  const results = d
    .prepare('SELECT * FROM case_results WHERE ulower(ticket) = ulower(?) ORDER BY finished_at')
    .all(ticket) as ResultRow[];
  const kept = cols.has('ticket')
    ? (d
        .prepare(
          `
            SELECT id, run_number, label, started_at, verdict, env, app_versions, lane,
              ${col(cols, 'batch_id')}
            FROM runs WHERE ulower(ticket) = ulower(?)
          `,
        )
        .all(ticket) as Omit<TicketRun, 'pruned'>[])
    : [];
  if (results.length === 0 && kept.length === 0) return undefined;

  const runsById = new Map<string, TicketRun>(kept.map(r => [r.id, { ...r, pruned: false }]));
  // A run removed by retention is still known from its case results.
  for (const r of results)
    if (!runsById.has(r.run_id))
      runsById.set(r.run_id, {
        id: r.run_id,
        run_number: r.run_number,
        label: null,
        started_at: null,
        verdict: null,
        env: null,
        app_versions: r.app_versions,
        lane: null,
        batch_id: null,
        pruned: true,
      });
  const ordered = [...runsById.values()].toSorted(
    (a, b) =>
      (a.run_number ?? 0) - (b.run_number ?? 0) ||
      (a.lane ?? 0) - (b.lane ?? 0) ||
      a.id.localeCompare(b.id),
  );
  const newestBuild = buildOf(ordered.at(-1)?.app_versions ?? null);

  const columnsById = new Map<
    string,
    {
      first: TicketRun;
      lanes: { id: string; lane: number | null; verdict: string | null; pruned: boolean }[];
    }
  >();
  for (const r of ordered) {
    const key = columnOf(r);
    const column = columnsById.get(key) ?? { first: r, lanes: [] };
    // A removed run's verdict is what its cases gave, as in the ticket list.
    const verdict = r.pruned
      ? (verdictOfResults(results.filter(x => x.run_id === r.id).map(x => x.result)) ?? null)
      : r.verdict;
    column.lanes.push({ id: r.id, lane: r.lane, verdict, pruned: r.pruned });
    columnsById.set(key, column);
  }
  const columnByRun = new Map(ordered.map(r => [r.id, columnOf(r)]));

  const defs = new Map(
    (hasTable(d, 'cases')
      ? (d
          .prepare('SELECT case_id, title FROM cases WHERE ulower(ticket) = ulower(?)')
          .all(ticket) as { case_id: string; title: string | null }[])
      : []
    ).map(c => [c.case_id, c.title]),
  );
  const evidenceCount = new Map(
    (hasEvidence(d)
      ? (d
          .prepare(
            `
              SELECT case_id, COUNT(*) AS n FROM evidence
              WHERE ulower(ticket) = ulower(?) AND case_id IS NOT NULL GROUP BY case_id
            `,
          )
          .all(ticket) as { case_id: string; n: number }[])
      : []
    ).map(e => [e.case_id.toLowerCase(), e.n]),
  );
  const caseIds = [...new Set([...defs.keys(), ...results.map(r => r.case_id)])].toSorted(byCaseId);
  const cases = caseIds.map(id => {
    const mine = results.filter(r => r.case_id === id);
    const latest = mine.at(-1);
    return {
      caseId: id,
      title: defs.get(id) ?? null,
      cells: Object.fromEntries(
        mine.map(r => [columnByRun.get(r.run_id)!, { result: r.result, judgedBy: r.judged_by }]),
      ),
      current: latest
        ? {
            ...caseResult(latest),
            build: parse(latest.app_versions),
            olderBuild: otherBuild(buildOf(latest.app_versions), newestBuild),
          }
        : null,
      evidence: evidenceCount.get(id.toLowerCase()) ?? 0,
    };
  });
  return {
    ticket: results.at(-1)?.ticket ?? ticket,
    title: titles(d).get(ticket.toLowerCase()) ?? null,
    runs: [...columnsById].map(([id, { first, lanes }]) => ({
      id,
      runNumber: first.run_number,
      label: first.label?.replace(/ lane \d+$/, '') ?? null,
      startedAt: first.started_at,
      verdict: worst(lanes.map(l => l.verdict)),
      env: first.env,
      pruned: lanes.every(l => l.pruned),
      lanes,
      app_versions: parse(first.app_versions),
    })),
    cases,
  };
}

/** One case of a ticket: what it checks, and its result, checks and screenshots in each run. */
export function caseDetail(ticket: string, caseId: string, links: Links = FILES) {
  const d = database();
  if (!d || !hasTable(d, 'case_results')) return undefined;
  const def = hasTable(d, 'cases')
    ? (d
        .prepare(
          'SELECT * FROM cases WHERE ulower(ticket) = ulower(?) AND ulower(case_id) = ulower(?)',
        )
        .get(ticket, caseId) as Record<string, string | null> | undefined)
    : undefined;
  const field = (name: string) => def?.[name] ?? null;
  const results = d
    .prepare(
      `
        SELECT * FROM case_results WHERE ulower(ticket) = ulower(?) AND ulower(case_id) = ulower(?)
        ORDER BY run_number, finished_at
      `,
    )
    .all(ticket, caseId) as ResultRow[];
  if (!def && results.length === 0) return undefined;
  const runOf = d.prepare(
    'SELECT id, label, env, started_at, finished_at, verdict, lane FROM runs WHERE id = ?',
  );
  const shotsOf = d.prepare(
    `
      SELECT step_seq, path FROM artifacts
      WHERE run_id = ? AND kind = 'screenshot' AND step_seq BETWEEN ? AND ?
      ORDER BY step_seq, rowid
    `,
  );
  const history = results.map(r => {
    const run = runOf.get(r.run_id) as Record<string, string | null> | undefined;
    const shots =
      run && r.step_from != null && r.step_to != null
        ? (shotsOf.all(r.run_id, r.step_from, r.step_to) as { step_seq: number; path: string }[])
        : [];
    return {
      ...caseResult(r),
      run: run ?? null,
      // A result of the case before it was last changed in its case file.
      earlierVersion: !!def?.hash && !!r.case_hash && r.case_hash !== def.hash,
      app_versions: parse(r.app_versions),
      // Frames are taken while a tool works; verify and fail shots are what it checked.
      screenshots: shots.map(s => ({
        step: s.step_seq,
        url: links.shot(r.run_id, basename(s.path)),
        frame: /-frame(-\d+)?\.png$/.test(s.path),
      })),
    };
  });
  const picked = hasEvidence(d)
    ? (
        d
          .prepare(
            `
              SELECT * FROM evidence
              WHERE ulower(ticket) = ulower(?) AND ulower(case_id) = ulower(?) ORDER BY id
            `,
          )
          .all(ticket, caseId) as EvidenceRow[]
      ).map(e => ({
        id: e.id,
        caption: e.caption,
        runId: e.run_id,
        step: e.step_seq,
        postedUrl: e.posted_url,
        url: links.evidence(e),
      }))
    : [];
  return {
    ticket: results.at(-1)?.ticket ?? def?.ticket ?? ticket,
    caseId: results.at(-1)?.case_id ?? def?.case_id ?? caseId,
    definition: def
      ? {
          title: def.title,
          steps: parse(field('steps_json')),
          expected: def.expected,
          needs: parse(field('needs_json')),
          after: parse(field('after_json')),
          block: parse(field('block_json')),
        }
      : null,
    history,
    evidence: picked,
  };
}

type EvidenceRow = {
  id: number;
  ticket: string;
  case_id: string | null;
  caption: string;
  path: string;
  run_id: string;
  step_seq: number;
  tool: string | null;
  created_at: string;
  posted_url: string | null;
};

const hasEvidence = (d: DatabaseSync) => hasTable(d, 'evidence');

/**
 * Every ticket with evidence, newest first, each with its screenshots in the order they were
 * picked.
 */
/** Picked screenshots by ticket, the ticket with the latest pick first. */
export function evidence(links: Links = FILES) {
  const d = database();
  if (!d || !hasEvidence(d)) return [];
  const rows = d.prepare('SELECT * FROM evidence ORDER BY id').all() as EvidenceRow[];
  const byTicket = new Map<string, EvidenceRow[]>();
  for (const r of rows) byTicket.set(r.ticket, [...(byTicket.get(r.ticket) ?? []), r]);
  return [...byTicket.entries()]
    .map(([ticket, items]) => ({
      ticket,
      latest: items.at(-1)!.created_at,
      items: items.map(r => ({
        id: r.id,
        case: r.case_id,
        caption: r.caption,
        runId: r.run_id,
        step: r.step_seq,
        tool: r.tool,
        postedUrl: r.posted_url,
        url: links.evidence(r),
        file: fromStored(r.path),
      })),
    }))
    .toSorted((a, b) => b.latest.localeCompare(a.latest));
}

/** The file of a picked screenshot, only inside the evidence folder. */
export function evidenceFile(id: number): string | undefined {
  const d = database();
  const row =
    d && hasEvidence(d)
      ? (d.prepare('SELECT path FROM evidence WHERE id = ?').get(id) as
          | { path: string }
          | undefined)
      : undefined;
  const file = row && fromStored(row.path);
  if (!file?.startsWith(`${EVIDENCE_DIR}/`) || !existsSync(file) || !statSync(file).isFile())
    return undefined;
  return file;
}

/** A screenshot of a run, only inside that run's screenshots folder. */
export function screenshotFile(runId: string, name: string): string | undefined {
  if (!/^[0-9a-z-]+$/.test(runId) || !/^[\w.-]+\.png$/.test(name)) return undefined;
  const dir = resolve(runDir(runId), 'screenshots');
  const file = resolve(dir, name);
  if (!file.startsWith(`${dir}/`) || !existsSync(file) || !statSync(file).isFile())
    return undefined;
  return file;
}

/** Closes the read connection (a CLI before it exits, tests between stores). */
export function closeReader() {
  db?.close();
  db = undefined;
}

/** A ticket's case results and numbered runs, for its QA ledger. */
export function ledgerRows(ticket: string): { results: LedgerResult[]; runs: LedgerRun[] } {
  const d = database();
  if (!d) return { results: [], runs: [] };
  const cols = (table: string) =>
    (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
  let results: LedgerResult[] = [];
  if (hasTable(d, 'case_results')) {
    const env = cols('case_results').includes('env') ? 'env' : 'NULL AS env';
    results = d
      .prepare(
        `
          SELECT run_id, case_id, run_number, ${env}, result, actual, note, case_hash, finished_at
          FROM case_results WHERE lower(ticket) = lower(?)
        `,
      )
      .all(ticket) as LedgerResult[];
  }
  const runCols = cols('runs');
  const numbered = runCols.includes('ticket')
    ? (d
        .prepare(
          `
            SELECT id, run_number, env, started_at, verdict,
              ${runCols.includes('lane') ? 'lane' : 'NULL AS lane'} FROM runs
            WHERE lower(ticket) = lower(?) AND run_number IS NOT NULL
          `,
        )
        .all(ticket) as LedgerRun[])
    : [];
  return { results, runs: numbered };
}

/** A run as a report shows it. */
export type ReportRun = {
  id: string;
  ticket: string | null;
  label: string | null;
  branch: string | null;
  env: string;
  run_tag: string;
  started_at: string;
  finished_at: string | null;
  verdict: string | null;
  summary: string | null;
  app_versions: string | null;
};

const REPORT_COLUMNS = `id, ticket, label, branch, env, run_tag, started_at, finished_at,
  verdict, summary, app_versions`;

/** One run, or the latest runs of a ticket (3 by default, at most 10), newest first. */
export function reportRuns(opts: { runId?: string; ticket?: string; last?: number }): ReportRun[] {
  const d = database();
  if (!d) return [];
  if (opts.runId) {
    const r = d.prepare(`SELECT ${REPORT_COLUMNS} FROM runs WHERE id = ?`).get(opts.runId);
    return r ? [r as ReportRun] : [];
  }
  return d
    .prepare(
      `
        SELECT ${REPORT_COLUMNS} FROM runs
        WHERE ulower(ticket) = ulower(?)
        ORDER BY started_at DESC, id DESC LIMIT ?
      `,
    )
    .all(opts.ticket ?? '', Math.min(Math.max(opts.last ?? 3, 1), 10)) as ReportRun[];
}

/** A run's failed steps, the first ten, with the message each answered with. */
export function failedSteps(runId: string) {
  const d = database();
  if (!d) return [];
  return (
    d
      .prepare(
        `
          SELECT seq, tool, error_code, observation_json FROM steps
          WHERE run_id = ? AND ok = 0
          ORDER BY seq LIMIT 10
        `,
      )
      .all(runId) as {
      seq: number;
      tool: string;
      error_code: string | null;
      observation_json: string | null;
    }[]
  ).map(f => ({
    seq: f.seq,
    tool: f.tool,
    errorCode: f.error_code,
    message: (parse(f.observation_json) as { message?: string } | null)?.message ?? '',
  }));
}
