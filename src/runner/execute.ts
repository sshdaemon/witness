import {
  caseHash,
  envKeys,
  judgedByChecks,
  type Call,
  type CaseFile,
  type DataExpect,
  type ErrorExpect,
} from './caseFile.js';
import { checkData, checkError, type Check } from './expect.js';
import { capture, fill, type Vars } from './fill.js';
import { app } from '../app.js';

/** A tool's answer as the runner sees it. */
export type Answer = {
  isError: boolean;
  out: {
    ok?: boolean;
    code?: string;
    message?: string;
    data?: Record<string, unknown> & { runId?: string; runTag?: string };
    step?: number;
  };
};
export type Caller = (name: string, args: Record<string, unknown>) => Promise<Answer>;

export type CaseVerdict = { result: string; actual?: string; note?: string };
/**
 * The session's verdicts. Each new version is applied as it comes; final ends the wait, so the
 * session can correct its verdicts and check them before the run is finished.
 */
export type VerdictFile = {
  summary?: string;
  cases?: Record<string, CaseVerdict>;
  final?: boolean;
};

const WAITING = "waiting for the session's verdict";

export type RunOptions = {
  /** The cases to run; their after chains are added. */
  order: string[];
  env?: string;
  branch?: string;
  firstRun?: number;
  log: (line: string) => void;
  /**
   * The next version of the session's verdict file, read after cleanup; undefined when none came
   * in time. Left out, the run does not wait.
   */
  nextVerdict?: () => Promise<VerdictFile | undefined>;
  /** Called once the run exists, with its id. */
  onStarted?: (runId: string) => void;
  /** The batch of parallel lanes this run is one of, and its lane. */
  batch?: string;
  lane?: number;
  /** Store the case definitions (false for all lanes but one). */
  define?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

export type CaseOutcome = {
  caseId: string;
  result: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN';
  judgedBy: 'checks' | 'session';
  note?: string;
  actual?: string;
  checks: Check[];
  /** Ran without a judgement: its reads wait for the session's verdict. */
  waiting?: boolean;
};

const short = (v: unknown, n = 160) => {
  const s = JSON.stringify(v) ?? 'nothing';
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/** One case's line of the run summary. */
function summaryLine(o: CaseOutcome, title: string): string {
  if (o.result === 'PASS') return `ok: ${o.caseId} ${title}`;
  if (o.result === 'FAIL') {
    const why =
      o.actual ??
      o.checks
        .filter(k => !k.ok)
        .map(k => `${k.path} ${k.check} ${short(k.want, 60)}, found ${short(k.got, 60)}`)
        .join('; ');
    return `FAIL: ${o.caseId} ${why}`;
  }
  const word = o.result === 'NOT_RUN' ? 'NOT RUN' : 'BLOCKED';
  return `${word}: ${o.caseId} ${o.note ?? ''}`.trim();
}

/**
 * Runs a case file's selected cases in one run: each fixture is built on first use, each case
 * between case_begin and case_end with its expects checked, then cleanup, the session's verdicts
 * if it gives any, run_finish and session_end.
 */
export async function runCaseFile(
  file: CaseFile,
  call: Caller,
  opts: RunOptions,
): Promise<{ runId?: string; outcomes: CaseOutcome[]; summary: string }> {
  const { log } = opts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  const now = opts.now ?? (() => new Date());

  const started = await call('session_start', {
    topic: file.topic,
    ticket: file.ticket,
    kind: 'test',
    ...(opts.env ? { env: opts.env } : {}),
    ...((opts.branch ?? file.branch) ? { branch: opts.branch ?? file.branch } : {}),
    ...(opts.firstRun ? { firstRun: opts.firstRun } : {}),
    ...(opts.batch ? { batch: opts.batch, lane: opts.lane } : {}),
  });
  if (started.isError) {
    log(`> session_start ERROR ${started.out.code}: ${started.out.message}`);
    return { outcomes: [], summary: 'The session did not start.' };
  }
  const runId = started.out.data?.runId as string;
  const env = String(started.out.data?.env ?? opts.env ?? '');
  log(`> ${String(started.out.data?.label ?? 'run')} · ${runId} · ${env}`);
  opts.onStarted?.(runId);

  if (opts.define !== false) {
    const defined = await call('cases_define', {
      ticket: file.ticket,
      cases: Object.entries(file.cases).map(([caseId, c]) => ({
        caseId,
        title: c.title,
        ...(c.steps ? { steps: c.steps } : {}),
        ...(c.expected ? { expected: c.expected } : {}),
        ...(c.needs?.length ? { needs: c.needs } : {}),
        ...(c.after?.length ? { after: c.after } : {}),
        block: c.block,
        hash: caseHash(c, file.fixtures),
      })),
    });
    if (defined.isError) log(`> cases_define ERROR ${defined.out.code}: ${defined.out.message}`);
  }

  const vars: Vars = {
    TAG: String(started.out.data?.runTag ?? ''),
    values: {},
    lists: {},
    named: {},
    env: file.env?.[env] ?? {},
  };

  /** Runs one call; the reason it stops what it belongs to, if it does, and its checks. */
  const run = async (c: Call): Promise<{ stop?: string; checks: Check[] }> => {
    const [name, rawArgs, o] = c;
    if (name === 'sleep') {
      await sleep(Number(rawArgs.seconds) * 1000);
      log('> sleep done');
      return { checks: [] };
    }
    const wait = app().runner?.waits?.[name];
    if (wait) {
      const ms = wait(rawArgs, now());
      await sleep(ms);
      log(`> ${name} done after ${Math.round(ms / 1000)} s`);
      return { checks: [] };
    }
    const { value: args, missing } = fill(rawArgs, vars);
    if (missing.length > 0)
      return {
        stop: `${name}: no value for ${missing.map(m => `{{${m}}}`).join(', ')}`,
        checks: [],
      };
    const answer = await call(name, args);
    const { out } = answer;
    const data = (out.data ?? {}) as Record<string, unknown>;
    if (!answer.isError) {
      capture(name, data, vars);
      if (o?.as) vars.named[o.as] = { ...vars.named[o.as], ...data };
    }
    const seq = out.step ?? 0;
    log(`> ${name} ${answer.isError ? `ERROR ${out.code}: ${out.message ?? ''}` : 'ok'}`);
    // Expected values may name run values too ("contains": "{{TAG}} mug").
    const { value: expect, missing: unknownWant } = fill(o?.expect, vars);
    if (unknownWant.length > 0)
      return {
        stop: `${name}: no value for ${unknownWant.map(m => `{{${m}}}`).join(', ')} in its expect`,
        checks: [],
      };
    if (expect && !Array.isArray(expect)) {
      const check = checkError(expect as ErrorExpect, { isError: answer.isError, ...out }, seq);
      if (!check.ok) log(`  ✕ expected ${short(check.want)}, got ${short(check.got)}`);
      return { checks: [check] };
    }
    if (answer.isError)
      return o?.mayFail
        ? { checks: [] }
        : { stop: `${name}: ${out.code ?? 'error'} ${out.message ?? ''}`.trim(), checks: [] };
    const checks = ((expect as DataExpect[] | undefined) ?? []).map(e => checkData(e, data, seq));
    for (const k of checks.filter(check => !check.ok))
      log(`  ✕ ${k.path} ${k.check} ${short(k.want)}, found ${short(k.got)}`);
    return { checks };
  };

  const fixtures = new Map<string, string | null>(); // name → why it failed, or null when built
  const build = async (name: string): Promise<string | null> => {
    if (fixtures.has(name)) return fixtures.get(name)!;
    log(`> fixture ${name}`);
    let failed: string | null = null;
    for (const c of file.fixtures![name]!) {
      const r = await run(c);
      const bad = r.checks.find(k => !k.ok);
      if (r.stop || bad) {
        failed =
          r.stop ?? `${bad!.path} ${bad!.check} ${short(bad!.want)}, found ${short(bad!.got)}`;
        break;
      }
    }
    fixtures.set(name, failed);
    return failed;
  };

  const outcomes = new Map<string, CaseOutcome>();
  const record = async (first: CaseOutcome, hash: string) => {
    let o = first;
    outcomes.set(o.caseId, o);
    const ended = await call('case_end', {
      caseId: o.caseId,
      result: o.result,
      judgedBy: o.judgedBy,
      ...(o.note ? { note: o.note.slice(0, 2000) } : {}),
      ...(o.checks.length > 0 ? { checks: o.checks } : {}),
      caseHash: hash,
    });
    if (ended.isError) {
      log(`> case_end ${o.caseId} ERROR ${ended.out.code}: ${ended.out.message}`);
      // The case must close, or every later case_begin answers CASE_OPEN.
      const note = `not recorded: ${ended.out.code} ${ended.out.message ?? ''}`.slice(0, 2000);
      await call('case_end', { caseId: o.caseId, result: 'BLOCKED', judgedBy: 'session', note });
      o = { ...o, result: 'BLOCKED', judgedBy: 'session', note, waiting: false };
      outcomes.set(o.caseId, o);
    }
    log(`= ${o.caseId} ${o.result}${o.note ? ` (${o.note})` : ''}`);
  };

  // Each lane is its own browser, so what every case relies on (logins) runs in every lane.
  let setupFailed: string | undefined;
  for (const c of file.setup ?? []) {
    const r = await run(c);
    const bad = r.checks.find(k => !k.ok);
    if (r.stop || bad) {
      setupFailed =
        r.stop ?? `${bad!.path} ${bad!.check} ${short(bad!.want)}, found ${short(bad!.got)}`;
      break;
    }
  }

  for (const id of opts.order) {
    const def = file.cases[id]!;
    const hash = caseHash(def, file.fixtures);
    const notRun = (note: string) =>
      record({ caseId: id, result: 'NOT_RUN', judgedBy: 'session', note, checks: [] }, hash);
    if (setupFailed) {
      await notRun(`setup failed: ${setupFailed}`);
      continue;
    }

    // A case only waiting for its verdict ran, so the cases after it can run too.
    const before = (def.after ?? []).find(a => {
      const o = outcomes.get(a);
      return !o || o.result === 'NOT_RUN' || (o.result === 'BLOCKED' && !o.waiting);
    });
    if (before) {
      await notRun(
        `runs after ${before}, which ${
          outcomes.get(before)?.result === 'NOT_RUN' ? 'did not run' : 'was blocked'
        }`,
      );
      continue;
    }
    const needEnv = envKeys([def.block, ...(def.needs ?? []).map(f => file.fixtures?.[f])]).filter(
      k => vars.env[k] === undefined,
    );
    if (needEnv.length > 0) {
      await notRun(`env ${env} has no ${needEnv.join(', ')}`);
      continue;
    }
    let fixtureFailed: string | undefined;
    for (const f of def.needs ?? []) {
      const why = await build(f);
      if (why) {
        fixtureFailed = `fixture ${f} failed: ${why}`;
        break;
      }
    }
    if (fixtureFailed) {
      await notRun(fixtureFailed);
      continue;
    }

    const begun = await call('case_begin', { caseId: id });
    if (begun.isError) {
      log(`> case_begin ${id} ERROR ${begun.out.code}: ${begun.out.message}`);
      outcomes.set(id, {
        caseId: id,
        result: 'BLOCKED',
        judgedBy: 'session',
        note: begun.out.message,
        checks: [],
      });
      continue;
    }
    log(`> case ${id} · ${def.title}`);
    const checks: Check[] = [];
    let stop: string | undefined;
    for (const c of def.block) {
      const r = await run(c);
      checks.push(...r.checks);
      if (r.stop) {
        stop = r.stop;
        break;
      }
    }
    // A case is judged by its checks when it has some and every evidence read carries one.
    const judged = judgedByChecks(def);
    const failed = checks.some(k => !k.ok);
    let outcome: CaseOutcome;
    if (stop) outcome = { caseId: id, result: 'BLOCKED', judgedBy: 'session', note: stop, checks };
    else if (failed) outcome = { caseId: id, result: 'FAIL', judgedBy: 'checks', checks };
    else if (judged) outcome = { caseId: id, result: 'PASS', judgedBy: 'checks', checks };
    else
      outcome = {
        caseId: id,
        result: 'BLOCKED',
        judgedBy: 'session',
        note: WAITING,
        checks,
        waiting: true,
      };
    await record(outcome, hash);
  }

  const cleanup = await call('cleanup_all', {});
  const left = (cleanup.out.data?.left as unknown[] | undefined) ?? [];
  let cleaned = 'ok';
  if (cleanup.isError) cleaned = `ERROR ${cleanup.out.code}`;
  else if (left.length > 0) cleaned = `left ${short(left)}`;
  log(`> cleanup_all ${cleaned}`);

  // Each version of the verdict file is applied as it comes, until one says it is final.
  let verdict: VerdictFile | undefined;
  const applied = new Map<string, string>();
  while (opts.nextVerdict) {
    const next = await opts.nextVerdict();
    if (!next) {
      log('> no final verdict file in time');
      break;
    }
    verdict = next;
    for (const [id, v] of Object.entries(next.cases ?? {})) {
      const known = outcomes.get(id);
      if (!known) {
        // Another lane's case; only an id the case file does not have is worth a word.
        if (!file.cases[id]) log(`> verdict for ${id} ignored: it is not a case of this file`);
        continue;
      }
      if (applied.get(id) === JSON.stringify(v)) continue;
      const ended = await call('case_end', {
        caseId: id,
        result: v.result,
        judgedBy: 'session',
        ...(v.actual ? { actual: v.actual } : {}),
        ...(v.note ? { note: v.note } : {}),
      });
      if (ended.isError) {
        log(`> case_end ${id} ERROR ${ended.out.code}: ${ended.out.message}`);
        continue;
      }
      applied.set(id, JSON.stringify(v));
      outcomes.set(id, {
        ...known,
        result: v.result as CaseOutcome['result'],
        judgedBy: 'session',
        note: v.note ?? (v.result === known.result ? known.note : undefined),
        actual: v.actual ?? known.actual,
        waiting: false,
      });
      log(`= ${id} ${v.result} (session)`);
    }
    if (next.final) break;
  }
  // A case nobody judged is blocked for want of a verdict, not still waiting.
  for (const o of outcomes.values()) {
    if (!o.waiting) continue;
    const ended = await call('case_end', {
      caseId: o.caseId,
      result: 'BLOCKED',
      judgedBy: 'session',
      note: 'no verdict',
    });
    if (ended.isError) log(`> case_end ${o.caseId} ERROR ${ended.out.code}: ${ended.out.message}`);
    outcomes.set(o.caseId, { ...o, note: 'no verdict', waiting: false });
  }

  const list = opts.order.map(id => outcomes.get(id)!).filter(Boolean);
  const summary =
    verdict?.summary ?? list.map(o => summaryLine(o, file.cases[o.caseId]!.title)).join(' | ');
  const finished = await call('run_finish', { summary: summary.slice(0, 4000) || 'No cases ran.' });
  log(
    `> run_finish ${
      finished.isError
        ? `ERROR ${finished.out.code}: ${finished.out.message}`
        : String(finished.out.data?.verdict ?? '')
    }`,
  );
  await call('session_end', {});
  return { runId, outcomes: list, summary };
}
