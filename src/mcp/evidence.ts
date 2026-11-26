import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { ToolError } from '../errors.js';
import { EVIDENCE_DIR, fromStored, toStored } from '../paths.js';
import { store } from './store.js';

/** A ticket or PR key used as a folder name, such as "AB-12" or "PR-3". */
export const TICKET = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$/;
/** A case id from a QA ledger: "C3", "C12b". */
export const CASE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,20}$/;

export type EvidenceItem = {
  id: number;
  ticket: string;
  case: string | null;
  caption: string;
  path: string;
  runId: string;
  step: number;
  tool: string | null;
  source: string;
  createdAt: string;
  postedUrl: string | null;
  postedAt: string | null;
};

type Row = {
  id: number;
  ticket: string;
  case_id: string | null;
  caption: string;
  path: string;
  run_id: string;
  step_seq: number;
  tool: string | null;
  source: string;
  created_at: string;
  posted_url: string | null;
  posted_at: string | null;
};

const item = (r: Row): EvidenceItem => ({
  id: r.id,
  ticket: r.ticket,
  case: r.case_id,
  caption: r.caption,
  path: fromStored(r.path),
  runId: r.run_id,
  step: r.step_seq,
  tool: r.tool,
  source: fromStored(r.source),
  createdAt: r.created_at,
  postedUrl: r.posted_url,
  postedAt: r.posted_at,
});

const slug = (text: string) =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 50) || 'shot';

// A label names a shot exactly ("verify", not "verify-before"); part of a file name is used only
// when it is unique.
function pickShot(shots: string[], shot: number | string): string | undefined {
  if (typeof shot === 'number') return shots[shot - 1];
  const label = new RegExp(`-${shot.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?\\.png$`);
  const exact = shots.filter(p => label.test(basename(p)));
  if (exact.length > 0) return exact.at(-1);
  const partial = shots.filter(p => basename(p).includes(shot));
  if (partial.length > 1)
    throw new ToolError(
      'SHOT_AMBIGUOUS',
      `${partial.length} screenshots of the step match "${shot}".`,
      `Pass one of: ${partial.map(p => basename(p)).join(', ')}, or its position.`,
    );
  return partial[0];
}

/**
 * Copies one screenshot of a run's step into the ticket's evidence folder and records it. `shot`
 * picks the frame: its 1-based position among the step's screenshots, or a part of its file name;
 * the last one by default.
 */
export function pickEvidence(o: {
  runId: string;
  step: number;
  shot?: number | string;
  ticket: string;
  caseId?: string;
  caption: string;
}): EvidenceItem {
  const db = store();
  const step = db
    .prepare('SELECT tool FROM steps WHERE run_id = ? AND seq = ?')
    .get(o.runId, o.step) as { tool: string } | undefined;
  if (!step)
    throw new ToolError('STEP_NOT_FOUND', `Run ${o.runId} has no step ${o.step}.`, 'See run_get.');
  const shots = (
    db
      .prepare(
        `
          SELECT path FROM artifacts
          WHERE run_id = ? AND step_seq = ? AND kind = 'screenshot'
          ORDER BY rowid
        `,
      )
      .all(o.runId, o.step) as { path: string }[]
  ).map(a => a.path);
  if (shots.length === 0)
    throw new ToolError(
      'NO_SCREENSHOT',
      `Step ${o.step} of run ${o.runId} kept no screenshot.`,
      'Repeat the read with purpose verify, which keeps one.',
    );
  const chosen = o.shot === undefined ? shots.at(-1) : pickShot(shots, o.shot);
  if (!chosen)
    throw new ToolError(
      'SHOT_NOT_FOUND',
      `Step ${o.step} has no screenshot ${o.shot}.`,
      `It has: ${shots.map(p => basename(p)).join(', ')}.`,
    );
  const source = fromStored(chosen);
  if (!existsSync(source))
    throw new ToolError(
      'SCREENSHOT_GONE',
      `${basename(source)} is no longer on disk.`,
      'The run may be past its retention; re-run the check.',
    );

  const dir = resolve(EVIDENCE_DIR, o.ticket);
  mkdirSync(dir, { recursive: true });
  const base = `${o.caseId ? `${o.caseId.toLowerCase()}-` : ''}${slug(o.caption)}`;
  let path = resolve(dir, `${base}.png`);
  for (let n = 2; existsSync(path); n++) path = resolve(dir, `${base}-${n}.png`);
  copyFileSync(source, path);

  const { lastInsertRowid } = db
    .prepare(
      `
        INSERT INTO evidence (
          ticket, case_id, caption, path, run_id, step_seq, tool, source, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      o.ticket,
      o.caseId ?? null,
      o.caption,
      toStored(path),
      o.runId,
      o.step,
      step.tool,
      toStored(source),
      new Date().toISOString(),
    );
  return getEvidence(Number(lastInsertRowid))!;
}

export function getEvidence(id: number): EvidenceItem | undefined {
  const r = store().prepare('SELECT * FROM evidence WHERE id = ?').get(id) as Row | undefined;
  return r && item(r);
}

/** A ticket's evidence in the order it was picked, or every ticket's when none is given. */
export function listEvidence(ticket?: string): EvidenceItem[] {
  const rows = (
    ticket
      ? store().prepare('SELECT * FROM evidence WHERE ticket = ? ORDER BY id').all(ticket)
      : store().prepare('SELECT * FROM evidence ORDER BY ticket, id').all()
  ) as Row[];
  return rows.map(item);
}

/**
 * Records where the image was uploaded, so the ticket comment and the evidence point at each other.
 */
export function markPosted(id: number, url: string): EvidenceItem {
  const done = store()
    .prepare('UPDATE evidence SET posted_url = ?, posted_at = ? WHERE id = ?')
    .run(url, new Date().toISOString(), id);
  if (!done.changes) throw new ToolError('EVIDENCE_NOT_FOUND', `No evidence ${id}.`);
  return getEvidence(id)!;
}

/** Removes a picked screenshot and its record; the run's own screenshot stays. */
export function removeEvidence(id: number): EvidenceItem {
  const found = getEvidence(id);
  if (!found) throw new ToolError('EVIDENCE_NOT_FOUND', `No evidence ${id}.`);
  rmSync(found.path, { force: true });
  store().prepare('DELETE FROM evidence WHERE id = ?').run(id);
  return found;
}
