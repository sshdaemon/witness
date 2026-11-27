import { ToolError } from '../errors.js';
import { prose } from '../prose.js';
import { runLabel } from './names.js';
import {
  store,
  verdictOfResults,
  type CaseResult,
  type CaseResultRow,
  type Check,
  type JudgedBy,
  type Verdict,
} from './store.js';

export {
  CASE_RESULTS,
  caseResultsFor,
  type CaseResult,
  type CaseResultRow,
  type Check,
  type JudgedBy,
} from './store.js';

/**
 * Gives the run the ticket's next number, and with withLabel the label "<ticket> run <n>" when it
 * has none. Numbers start at firstRun at the lowest, for a ticket whose earlier runs were numbered
 * by hand. Call inside a write transaction, so two processes never take the same number.
 */
export function numberRun(
  runId: string,
  ticket: string,
  firstRun?: number,
  withLabel = true,
): { runNumber: number; label: string | null } {
  const d = store();
  const key = ticket.trim().toLowerCase();
  const { label, batch_id, lane } = d
    .prepare('SELECT label, batch_id, lane FROM runs WHERE id = ?')
    .get(runId) as { label: string | null; batch_id: string | null; lane: number | null };
  // The lanes of one batch are one run of the ticket: the first to start takes the number.
  const sibling = batch_id
    ? (d
        .prepare(
          `
            SELECT run_number FROM runs
            WHERE batch_id = ? AND id != ? AND run_number IS NOT NULL LIMIT 1
          `,
        )
        .get(batch_id, runId) as { run_number: number } | undefined)
    : undefined;
  let runNumber: number;
  if (sibling) runNumber = sibling.run_number;
  else {
    const { last } = (d
      .prepare('SELECT last_run AS last FROM ticket_runs WHERE ticket = ?')
      .get(key) as { last: number } | undefined) ?? { last: 0 };
    runNumber = Math.max(last + 1, firstRun ?? 1);
    d.prepare(
      `
        INSERT INTO ticket_runs (ticket, last_run) VALUES (?, ?)
        ON CONFLICT (ticket) DO UPDATE SET last_run = excluded.last_run
      `,
    ).run(key, runNumber);
  }
  const made = runLabel.safeParse(
    `${ticket} run ${runNumber}${batch_id && lane ? ` lane ${lane}` : ''}`,
  );
  const newLabel = label ?? (withLabel && made.success ? made.data : null);
  d.prepare('UPDATE runs SET ticket = ?, run_number = ?, label = ? WHERE id = ?').run(
    ticket,
    runNumber,
    newLabel,
    runId,
  );
  return { runNumber, label: newLabel };
}

/** Runs fn in a write transaction that waits for other processes rather than failing. */
export function inWriteTransaction<T>(fn: () => T): T {
  const d = store();
  d.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

export function getCaseResult(
  runId: string,
  ticket: string,
  caseId: string,
): CaseResultRow | undefined {
  return store()
    .prepare('SELECT * FROM case_results WHERE run_id = ? AND ticket = ? AND case_id = ?')
    .get(runId, ticket, caseId) as CaseResultRow | undefined;
}

/** The result a case's checks give on their own: FAIL when any failed, else PASS. */
export const resultOfChecks = (checks: Check[]): CaseResult =>
  checks.some(c => !c.ok) ? 'FAIL' : 'PASS';

/**
 * A result said to come from the checks must be what they gave, and a judgement that differs from
 * them needs a note.
 */
function assertJudgement(
  caseId: string,
  r: { result: CaseResult; judgedBy: JudgedBy; note?: string | null },
  checksResult: CaseResult | null,
) {
  if (r.judgedBy === 'checks' && r.result !== checksResult)
    throw new ToolError(
      'CHECKS_MISMATCH',
      checksResult
        ? `The checks of ${caseId} gave ${checksResult}, not ${r.result}.`
        : `${caseId} has no checks to judge it by.`,
      'Pass the checks with the result they give, or judge it yourself (judgedBy session).',
    );
  if (r.judgedBy === 'session' && checksResult && r.result !== checksResult && !r.note)
    throw new ToolError(
      'NOTE_REQUIRED',
      `The checks of ${caseId} gave ${checksResult}, not ${r.result}.`,
      'Say in note why the reads show otherwise.',
    );
}

export function insertCaseResult(r: {
  runId: string;
  ticket: string;
  caseId: string;
  result: CaseResult;
  actual?: string;
  note?: string;
  stepFrom?: number;
  stepTo?: number;
  judgedBy: JudgedBy;
  checks?: Check[];
  caseHash?: string;
}) {
  assertJudgement(r.caseId, r, r.checks?.length ? resultOfChecks(r.checks) : null);
  const { app_versions, run_number, env } = (store()
    .prepare('SELECT app_versions, run_number, env FROM runs WHERE id = ?')
    .get(r.runId) as
    | { app_versions: string | null; run_number: number | null; env: string | null }
    | undefined) ?? { app_versions: null, run_number: null, env: null };
  store()
    .prepare(
      `
        INSERT INTO case_results (
          run_id, ticket, case_id, run_number, result, actual, note, step_from, step_to,
          judged_by, checks_result, checks_json, app_versions, finished_at, case_hash, env
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      r.runId,
      r.ticket,
      r.caseId,
      run_number,
      r.result,
      r.actual ?? null,
      r.note ?? null,
      r.stepFrom ?? null,
      r.stepTo ?? null,
      r.judgedBy,
      r.checks?.length ? resultOfChecks(r.checks) : null,
      r.checks?.length ? JSON.stringify(r.checks) : null,
      app_versions,
      new Date().toISOString(),
      r.caseHash ?? null,
      env,
    );
}

/**
 * A later verdict on a case already closed in this run: the session's judgement after the runner's
 * checks. Overriding what the checks found needs a note.
 */
export function updateCaseResult(
  existing: CaseResultRow,
  r: { result: CaseResult; actual?: string; note?: string; judgedBy: JudgedBy; checks?: Check[] },
) {
  const checksResult = r.checks?.length ? resultOfChecks(r.checks) : existing.checks_result;
  // A new result needs its own reason: the note of the one it replaces does not carry over.
  const note = r.note ?? (r.result === existing.result ? existing.note : null);
  assertJudgement(existing.case_id, { ...r, note }, checksResult);
  store()
    .prepare(
      `
        UPDATE case_results
        SET result = ?, actual = COALESCE(?, actual), note = ?, judged_by = ?,
          checks_result = ?, checks_json = COALESCE(?, checks_json), finished_at = ?
        WHERE run_id = ? AND ticket = ? AND case_id = ?
      `,
    )
    .run(
      r.result,
      r.actual ?? null,
      note,
      r.judgedBy,
      checksResult,
      r.checks?.length ? JSON.stringify(r.checks) : null,
      new Date().toISOString(),
      existing.run_id,
      existing.ticket,
      existing.case_id,
    );
}

/**
 * The run's verdict from its cases: FAIL when any failed, else BLOCKED when any was blocked or not
 * run, else PASS. Undefined when the run recorded no cases.
 */
export function verdictFromCases(runId: string): Verdict | undefined {
  const results = (
    store().prepare('SELECT result FROM case_results WHERE run_id = ?').all(runId) as {
      result: CaseResult;
    }[]
  ).map(r => r.result);
  return verdictOfResults(results);
}

export const caseOpenError = (caseId: string) =>
  new ToolError(
    'CASE_OPEN',
    `Case ${caseId} is still open.`,
    prose`
      Close it with case_end first; a case's steps run between its case_begin and its
      case_end.`,
  );

export type CaseDefinition = {
  caseId: string;
  title: string;
  steps?: string[];
  expected?: string;
  needs?: string[];
  after?: string[];
  block: unknown[];
  hash: string;
};

/** Stores a ticket's case definitions as the case file has them, replacing earlier versions. */
export function defineCases(ticket: string, cases: CaseDefinition[]) {
  const d = store();
  const put = d.prepare(
    `
      INSERT INTO cases (
        ticket, case_id, title, steps_json, expected, needs_json, after_json, block_json, hash,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (ticket, case_id) DO UPDATE SET
        title = excluded.title, steps_json = excluded.steps_json, expected = excluded.expected,
        needs_json = excluded.needs_json, after_json = excluded.after_json,
        block_json = excluded.block_json, hash = excluded.hash, updated_at = excluded.updated_at
    `,
  );
  // One spelling per ticket: an existing one wins, so the viewer's grouping stays put.
  const known = d
    .prepare('SELECT ticket FROM cases WHERE ulower(ticket) = ulower(?) LIMIT 1')
    .get(ticket) as { ticket: string } | undefined;
  const key = known?.ticket ?? ticket;
  const now = new Date().toISOString();
  inWriteTransaction(() => {
    for (const c of cases)
      put.run(
        key,
        c.caseId,
        c.title,
        c.steps ? JSON.stringify(c.steps) : null,
        c.expected ?? null,
        c.needs?.length ? JSON.stringify(c.needs) : null,
        c.after?.length ? JSON.stringify(c.after) : null,
        JSON.stringify(c.block),
        c.hash,
        now,
      );
  });
  return { ticket: key, defined: cases.length };
}

/**
 * Each case of a ticket, defined or only run, with its latest result and the builds it ran on;
 * with env, the latest result in that environment.
 */
export function ticketCases(ticket: string, env?: string) {
  const d = store();
  const defs = d
    .prepare('SELECT case_id, title, hash FROM cases WHERE ulower(ticket) = ulower(?)')
    .all(ticket) as { case_id: string; title: string | null; hash: string | null }[];
  const results = d
    .prepare(
      `
        SELECT * FROM case_results
        WHERE ulower(ticket) = ulower(?) AND (? IS NULL OR env = ?)
        ORDER BY finished_at
      `,
    )
    .all(ticket, env ?? null, env ?? null) as CaseResultRow[];
  const latest = new Map<string, CaseResultRow>();
  for (const r of results) latest.set(r.case_id, r);
  const ids = [...new Set([...defs.map(c => c.case_id), ...latest.keys()])].toSorted((a, b) =>
    a.localeCompare(b, 'en', { numeric: true }),
  );
  return ids.map(id => {
    const def = defs.find(c => c.case_id === id);
    const r = latest.get(id);
    return {
      caseId: id,
      title: def?.title ?? null,
      hash: def?.hash ?? null,
      latest: r
        ? {
            result: r.result,
            runId: r.run_id,
            runNumber: r.run_number,
            caseHash: r.case_hash,
            appVersions: r.app_versions ? (JSON.parse(r.app_versions) as unknown) : null,
          }
        : null,
    };
  });
}
