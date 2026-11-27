import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ToolError } from '../errors.js';
import { toStored } from '../paths.js';
import {
  caseOpenError,
  getCaseResult,
  insertCaseResult,
  inWriteTransaction,
  numberRun,
  updateCaseResult,
  type CaseResult,
  type Check,
  type JudgedBy,
} from './cases.js';
import { runDir, setTicketTitle, store, type Verdict } from './store.js';

const OBSERVATION_CAP = 4000;

// Keeps stored observations valid JSON: when too long, store a marker with the head of the text.
function capJson(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length <= OBSERVATION_CAP
    ? text
    : JSON.stringify({ truncated: true, head: text.slice(0, OBSERVATION_CAP) });
}

export class Recorder {
  readonly dir: string;
  readonly stepLogPath: string;
  private seq = 0;
  private firstFailure: number | undefined;
  /**
   * The call being recorded: its step number is known before it ends, so its screenshots can be
   * named after it.
   */
  private call?: { seq: number; tool: string; names: Set<string> };
  verdict?: Verdict;
  private traces: string[] = [];
  /** The ticket the run's cases belong to, its number for that ticket and its label. */
  ticket?: string;
  runNumber?: number;
  label?: string;
  /** The case between its case_begin and case_end, with the step its case_begin was recorded as. */
  private openCase?: { ticket: string; caseId: string; from: number };

  constructor(
    readonly runId: string,
    env: string,
    runTag: string,
    about: {
      title?: string;
      branch?: string;
      kind?: string;
      ticket?: string;
      label?: string;
      firstRun?: number;
      batch?: string;
      lane?: number;
    },
    builds?: unknown,
  ) {
    this.dir = runDir(runId);
    this.stepLogPath = resolve(this.dir, 'steps.jsonl');
    store(); // opens or migrates the store before anything is written
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.stepLogPath, '');
    this.label = about.label;
    inWriteTransaction(() => {
      store()
        .prepare(
          `
            INSERT INTO runs (
              id, branch, kind, env, run_tag, started_at, app_versions, label, batch_id, lane
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          runId,
          about.branch ?? null,
          about.kind ?? 'test',
          env,
          runTag,
          new Date().toISOString(),
          builds ? JSON.stringify(builds) : null,
          about.label ?? null,
          about.batch ?? null,
          about.batch ? (about.lane ?? null) : null,
        );
      if (about.ticket) this.takeTicket(about.ticket, about.firstRun);
      if (about.ticket && about.title) setTicketTitle(about.ticket, about.title);
    });
  }

  /**
   * Records the run's ticket and gives the run that ticket's next number. A ticket that arrives
   * after session_start leaves the label alone, as the names already built carry the old one.
   */
  private takeTicket(ticket: string, firstRun?: number, atStart = true) {
    const n = numberRun(this.runId, ticket, firstRun, atStart);
    this.ticket = ticket;
    this.runNumber = n.runNumber;
    this.label = n.label ?? undefined;
  }

  /** The ticket a case belongs to: the run's own, which a case may only repeat. */
  private caseTicket(given: string | undefined, tool: string): string {
    const ticket = this.ticket ?? given;
    if (!ticket)
      throw new ToolError('NO_TICKET', 'This run has no ticket.', `Pass ticket to ${tool}.`);
    if (given && given.toLowerCase() !== ticket.toLowerCase())
      throw new ToolError(
        'TICKET_MISMATCH',
        `This run tests ${ticket}, not ${given}.`,
        'Test another ticket in a run of its own.',
      );
    return ticket;
  }

  private assertOpen() {
    if (this.verdict)
      throw new ToolError(
        'RUN_FINISHED',
        `The run already has its verdict, ${this.verdict}.`,
        'Record cases before run_finish.',
      );
  }

  /** Opens a case: its steps run from this call to its case_end. */
  beginCase(caseId: string, given?: string) {
    this.assertOpen();
    const ticket = this.caseTicket(given, 'case_begin');
    if (this.openCase) throw caseOpenError(this.openCase.caseId);
    if (getCaseResult(this.runId, ticket, caseId))
      throw new ToolError(
        'CASE_ALREADY_RUN',
        `Case ${caseId} already ran in this run.`,
        'Run it again in a new run, or change its result with case_end.',
      );
    if (!this.ticket) inWriteTransaction(() => this.takeTicket(ticket, undefined, false));
    this.openCase = { ticket, caseId, from: this.call?.seq ?? this.seq + 1 };
    return { ticket, caseId, fromStep: this.openCase.from };
  }

  /**
   * Closes the open case with its step range, or gives a case already closed in this run its final
   * verdict. A case that never began can only be recorded as NOT_RUN.
   */
  endCase(e: {
    caseId: string;
    ticket?: string;
    result: CaseResult;
    actual?: string;
    note?: string;
    judgedBy?: JudgedBy;
    checks?: Check[];
    caseHash?: string;
  }) {
    this.assertOpen();
    const judgedBy = e.judgedBy ?? 'session';
    const ticket = this.caseTicket(e.ticket, 'case_end');
    const open = this.openCase;
    if (open && open.caseId === e.caseId) {
      insertCaseResult({
        ...e,
        judgedBy,
        runId: this.runId,
        ticket: open.ticket,
        stepFrom: open.from,
        stepTo: this.call?.seq ?? this.seq + 1,
      });
      this.openCase = undefined;
      return getCaseResult(this.runId, open.ticket, e.caseId)!;
    }
    if (open) throw caseOpenError(open.caseId);
    const existing = getCaseResult(this.runId, ticket, e.caseId);
    if (existing) {
      updateCaseResult(existing, { ...e, judgedBy });
      return getCaseResult(this.runId, ticket, e.caseId)!;
    }
    if (e.result !== 'NOT_RUN')
      throw new ToolError(
        'CASE_NOT_STARTED',
        `Case ${e.caseId} was not started in this run.`,
        'Call case_begin before its steps; only a case that did not run can end without one.',
      );
    if (!this.ticket) inWriteTransaction(() => this.takeTicket(ticket, undefined, false));
    insertCaseResult({ ...e, judgedBy, runId: this.runId, ticket });
    return getCaseResult(this.runId, ticket, e.caseId)!;
  }

  /** The case still open, if any. */
  openCaseId(): string | undefined {
    return this.openCase?.caseId;
  }

  /** Closes a case left open when the session ends, as BLOCKED at the last step. */
  closeOpenCase(note: string) {
    const open = this.openCase;
    if (!open) return;
    insertCaseResult({
      runId: this.runId,
      ticket: open.ticket,
      caseId: open.caseId,
      result: 'BLOCKED',
      note,
      stepFrom: open.from,
      stepTo: this.seq,
      judgedBy: 'session',
    });
    this.openCase = undefined;
  }

  /** Starts a tool call: the step it will be recorded as is the next one. */
  beginCall(tool: string) {
    this.call = { seq: this.seq + 1, tool, names: new Set() };
  }

  /**
   * Where a screenshot of the current call goes: "0007-product_publish-verify.png", numbered when a
   * label repeats.
   */
  shotPath(label: string): string {
    const dir = resolve(this.dir, 'screenshots');
    mkdirSync(dir, { recursive: true });
    const call = this.call ?? { seq: this.seq + 1, tool: 'step', names: new Set<string>() };
    const base = `${String(call.seq).padStart(4, '0')}-${call.tool}-${label}`;
    let name = base;
    for (let n = 2; call.names.has(name); n++) name = `${base}-${n}`;
    call.names.add(name);
    return resolve(dir, `${name}.png`);
  }

  /** Whether any step so far failed. */
  failed(): boolean {
    return this.firstFailure !== undefined;
  }

  step(s: {
    tool: string;
    args: unknown;
    ok: boolean;
    errorCode?: string;
    pageKind?: string;
    url?: string;
    durationMs: number;
    observation?: unknown;
    screenshotPaths?: string[];
  }): number {
    const seq = ++this.seq;
    if (!s.ok && this.firstFailure === undefined) this.firstFailure = seq;
    const observation = s.observation === undefined ? null : capJson(s.observation);
    store()
      .prepare(
        `
          INSERT INTO steps (
            run_id, seq, tool, args_json, ok, error_code, page_kind, url, duration_ms,
            observation_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        this.runId,
        seq,
        s.tool,
        JSON.stringify(s.args ?? {}),
        s.ok ? 1 : 0,
        s.errorCode ?? null,
        s.pageKind ?? null,
        s.url ?? null,
        s.durationMs,
        observation,
      );
    appendFileSync(
      this.stepLogPath,
      `${JSON.stringify({
        t: new Date().toISOString(),
        seq,
        tool: s.tool,
        args: s.args,
        ok: s.ok,
        code: s.errorCode,
        page: s.pageKind,
        ms: s.durationMs,
      })}\n`,
    );
    for (const path of s.screenshotPaths ?? []) this.artifact('screenshot', path, seq);
    return seq;
  }

  artifact(kind: string, path: string, stepSeq?: number) {
    let bytes: number | null = null;
    try {
      bytes = statSync(path).size;
    } catch {
      // file may not exist yet; the row still records where it will be
    }
    store()
      .prepare(`
        INSERT INTO artifacts (run_id, step_seq, kind, path, bytes) VALUES (?, ?, ?, ?, ?)
      `)
      .run(this.runId, stepSeq ?? null, kind, toStored(path), bytes);
  }

  finish(verdict: Verdict, summary: string, firstFailureStep?: number) {
    this.verdict = verdict;
    store()
      .prepare(
        `
          UPDATE runs SET finished_at = ?, verdict = ?, summary = ?, first_failure_step = ?
          WHERE id = ?
        `,
      )
      .run(
        new Date().toISOString(),
        verdict,
        summary,
        firstFailureStep ?? this.firstFailure ?? null,
        this.runId,
      );
  }

  addTrace(path: string) {
    this.traces.push(path);
    this.artifact('trace', path);
  }

  /** Removes the run's traces, files and records, once the run turned out not to need them. */
  dropTraces() {
    for (const path of this.traces) rmSync(path, { force: true });
    store().prepare("DELETE FROM artifacts WHERE run_id = ? AND kind = 'trace'").run(this.runId);
    this.traces = [];
  }
}
