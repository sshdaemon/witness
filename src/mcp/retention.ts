import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { RESULTS_DIR, runDir } from '../paths.js';
import { store } from './store.js';

const DEFAULT_DAYS = 14;
const DEFAULT_TOOL_DAYS = 3;
// A run nobody wrote to for this long belongs to a server process that is gone.
const ABANDONED_HOURS = 6;
// Run folders are named <yyyyMMddHHmmss>-<tag>; nothing else under runs/ is ever removed.
const RUN_NAME = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-[0-9a-z]+$/;

const wholeDays = (value: string | undefined, fallback: number) => {
  const days = Number(value);
  return value !== undefined && Number.isInteger(days) && days >= 1 ? days : fallback;
};

/**
 * How many days test runs are kept: WITNESS_RETENTION_DAYS when it is a whole number of at least 1,
 * else 14.
 */
export function retentionDays(value = process.env.WITNESS_RETENTION_DAYS): number {
  return wholeDays(value, DEFAULT_DAYS);
}

/**
 * How many days runs made only to exercise a tool are kept: WITNESS_TOOL_RETENTION_DAYS, else 3
 * (never longer than test runs).
 */
export function toolRetentionDays(value = process.env.WITNESS_TOOL_RETENTION_DAYS): number {
  return Math.min(wholeDays(value, DEFAULT_TOOL_DAYS), retentionDays());
}

/**
 * The start time a run folder's name records (UTC, as the run id is made), or undefined for any
 * other name.
 */
export function startedFromName(name: string): Date | undefined {
  const m = RUN_NAME.exec(name);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
  return new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!, s!));
}

/**
 * Deletes every run that started more than `days` ago: its rows in runs, steps and artifacts, and
 * its folder (step log, screenshots, traces). Run folders the store no longer knows are removed by
 * the date in their name.
 */
export function pruneOldRuns(
  now = new Date(),
  days = retentionDays(),
  toolDays = toolRetentionDays(),
): { runs: string[]; folders: string[] } {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const toolCutoff = new Date(now.getTime() - Math.min(toolDays, days) * 86_400_000);
  const db = store();
  // An unfinished run may still be recording in another server process: it ages from its last step,
  // not its start.
  const old = (
    db
      .prepare('SELECT id, started_at, finished_at, kind FROM runs WHERE started_at < ?')
      .all(toolCutoff.toISOString()) as {
      id: string;
      started_at: string;
      finished_at: string | null;
      kind: string | null;
    }[]
  )
    .filter(r => {
      const limit = r.kind === 'tool' ? toolCutoff : cutoff;
      return new Date(r.started_at) < limit && (r.finished_at || lastWrite(r.id) < limit);
    })
    .map(r => r.id);
  if (old.length > 0) {
    db.exec('BEGIN');
    try {
      for (const table of ['steps', 'artifacts']) {
        const del = db.prepare(`DELETE FROM ${table} WHERE run_id = ?`);
        for (const id of old) del.run(id);
      }
      const del = db.prepare('DELETE FROM runs WHERE id = ?');
      for (const id of old) del.run(id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  const folders: string[] = [];
  const runsRoot = resolve(RESULTS_DIR, 'runs');
  const known = new Set(
    (db.prepare('SELECT id FROM runs').all() as { id: string }[]).map(r => r.id),
  );
  for (const name of existsSync(runsRoot) ? readdirSync(runsRoot) : []) {
    const started = startedFromName(name);
    if (!started) continue;
    if (old.includes(name) || (!known.has(name) && started < cutoff && lastWrite(name) < cutoff)) {
      rmSync(runDir(name), { recursive: true, force: true });
      folders.push(name);
    }
  }
  return { runs: old, folders };
}

/**
 * Closes runs whose server process is gone: no verdict and nothing written for ABANDONED_HOURS.
 * They are recorded as ABORTED, as session_end does for a run without run_finish.
 */
export function sweepAbandonedRuns(now = new Date()): string[] {
  const limit = new Date(now.getTime() - ABANDONED_HOURS * 3_600_000);
  const db = store();
  const open = (
    db.prepare('SELECT id FROM runs WHERE finished_at IS NULL').all() as { id: string }[]
  ).filter(r => lastWrite(r.id) < limit);
  const close = db.prepare(
    `
      UPDATE runs
      SET verdict = 'ABORTED', finished_at = ?, summary = 'The server stopped before session_end'
      WHERE id = ? AND finished_at IS NULL
    `,
  );
  for (const r of open) close.run(now.toISOString(), r.id);
  return open.map(r => r.id);
}

/** When the run's step log or folder was last written; the epoch when neither exists. */
function lastWrite(runId: string): Date {
  for (const path of [resolve(runDir(runId), 'steps.jsonl'), runDir(runId)]) {
    try {
      return statSync(path).mtime;
    } catch {
      // try the next one
    }
  }
  return new Date(0);
}
