// Runs an app's tool calls from a JSON file through its real worker, the way a model would. A file
// holding an object is a ticket's case file, run case by case (see src/runner); a file
// holding an array is a plain list of calls:
//   [["tool", { args }], ["tool", { args }, { "mayFail": true }],
//    ["sleep", { "seconds": 60 }], ...]
// A call named in the app's runner.waits waits as long as it says, as in a case file.
// In args, {{TAG}} (run tag) and the values the app's runner.capture names are replaced. A step
// that fails and is not marked mayFail
// stops the run: only cleanup steps (*_cleanup, cleanup_all) still run, and the run is closed
// BLOCKED. With WAIT_VERDICT=<file> the run stays open until that file holds {"verdict","summary"},
// so the verdict follows the results.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { runDir } from '../paths.js';
import { parseCaseFile, runOrder, type CaseFile } from '../runner/caseFile.js';
import { runCaseFile, type Caller, type VerdictFile } from '../runner/execute.js';
import { missingCases } from '../runner/missing.js';
import { capture, fill as fillVars, type Vars } from '../runner/fill.js';
import { app, type EnvName } from '../app.js';
import { isLocalHost } from '../hosts.js';
import { planLanes, undeclaredUses } from '../runner/lanes.js';
import { laneClock, runLanes, verdictVersions } from '../runner/laneRun.js';
import { randomBytes } from 'node:crypto';

// Two or three lanes is what one local stack takes.
const MAX_LANES = 4;

export type Step = [string, Record<string, unknown>, { mayFail?: boolean }?];
type Out = {
  code?: string;
  message?: string;
  data?: Record<string, unknown> & { runTag?: string };
};

// The worker's shutdown (traces, browsers, an ABORTED record for a lane that ends without
// session_end) can outlast the SDK's close, which kills the process 4 s after ending its stdin. So
// its stdin is ended here first and its exit awaited, bounded, before the transport is closed.
const STOP_TIMEOUT = 60_000;
async function disconnect(c: Client) {
  const transport = c.transport as StdioClientTransport | undefined;
  // @ts-expect-error the SDK keeps the child process private; ending stdin is a normal shutdown
  const child = transport?._process as ChildProcess | undefined;
  if (child && child.exitCode === null) {
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.stdin?.end();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, STOP_TIMEOUT).unref())]);
  }
  await c.close();
}

// Wizards, uploads and slow stacks outlast the client's 60 s default.
const CALL_TIMEOUT = 10 * 60_000;

const isCleanup = (name: string) => name.endsWith('_cleanup') || name === 'cleanup_all';

// The file may be caught half-written, so one bad read is retried before the run closes BLOCKED.
async function readVerdict(path: string): Promise<{ verdict: string; summary: string }> {
  if (!existsSync(path))
    return { verdict: 'BLOCKED', summary: `No verdict appeared in ${path} within 20 minutes.` };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const v = JSON.parse(readFileSync(path, 'utf8')) as {
        verdict?: unknown;
        summary?: unknown;
      };
      if (typeof v.verdict === 'string' && typeof v.summary === 'string')
        return { verdict: v.verdict, summary: v.summary };
    } catch {
      // not complete yet
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return {
    verdict: 'BLOCKED',
    summary: `The verdict file ${path} does not hold {"verdict","summary"}.`,
  };
}

/** The app's worker script, started once per lane in the app's root (its checkout), with the
 * tsx from that checkout. */
export type StepsOptions = { worker: string };

/** A command line the runner cannot use; runSteps prints it and exits with code 2. */
export class UsageError extends Error {}

export type StepsArgs = {
  file: string;
  /** The value after a flag: '' when it is last, undefined when it is absent. */
  flag(name: string): string | undefined;
  has(name: string): boolean;
  caseFile?: CaseFile;
  steps: Step[];
};

/** Reads the command line and the file it names, before any worker starts. */
export function parseStepsArgs(
  argv: string[],
  envs: readonly string[],
  read: (path: string) => string = path => readFileSync(path, 'utf8'),
): StepsArgs {
  const [file, ...flags] = argv;
  if (!file)
    throw new UsageError(
      'usage: npm run steps -- <calls.json | cases.json> [--cases C1,C2 | --missing]' +
        ` [--env ${envs.join('|')}] [--branch <name>] [--first-run <n>]` +
        ' [--wait-minutes <n>] [--lanes <n>]',
    );
  const flag = (name: string) => {
    const i = flags.indexOf(name);
    return i !== -1 ? (flags[i + 1] ?? '') : undefined;
  };
  const envFlag = flag('--env');
  if (envFlag !== undefined && !envs.includes(envFlag))
    throw new UsageError(`--env is one of ${envs.join(', ')}.`);
  const raw = JSON.parse(read(file)) as unknown;
  const args: StepsArgs = { file, flag, has: name => flags.includes(name), steps: [] };
  if (Array.isArray(raw)) return { ...args, steps: raw as Step[] };
  let caseFile: CaseFile;
  try {
    caseFile = parseCaseFile(raw);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const unknown = (flag('--cases') ?? '').split(',').filter(c => c && !caseFile.cases[c]);
  if (unknown.length > 0)
    throw new UsageError(`Not cases of ${caseFile.ticket}: ${unknown.join(', ')}`);
  return { ...args, caseFile };
}

// Each lane is its own server, with its own session and browser. It is the tools process itself,
// not the proxy a session connects to: a run starts fresh, so it has no use for mcp_reload.
async function connect(opts: StepsOptions): Promise<Client> {
  const c = new Client({ name: 'run-steps', version: '0.0.0' });
  await c.connect(
    new StdioClientTransport({
      command: resolvePath(app().root, 'node_modules/.bin/tsx'),
      args: [opts.worker],
      cwd: app().root,
      stderr: 'ignore',
      env: Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>,
    }),
  );
  return c;
}

// A call that throws (timeout, server gone) is a failed step, so cleanup still runs.
async function call(
  through: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ out?: Out; isError: boolean }> {
  try {
    const res = (await through.callTool({ name, arguments: args }, { timeout: CALL_TIMEOUT })) as {
      structuredContent?: Out;
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    // A refusal before the tool runs (invalid input) carries only text content.
    const text = res.content?.find(c => c.type === 'text')?.text ?? '';
    return {
      out: res.structuredContent ?? {
        code: res.isError ? 'PROTOCOL_ERROR' : undefined,
        message: text,
      },
      isError: !!res.isError,
    };
  } catch (e) {
    return {
      out: { code: 'CALL_FAILED', message: e instanceof Error ? e.message : String(e) },
      isError: true,
    };
  }
}

const callerFor =
  (through: Client): Caller =>
  async (name, args) => {
    const r = await call(through, name, args);
    return { isError: r.isError, out: (r.out ?? {}) as Awaited<ReturnType<Caller>>['out'] };
  };

const maxChars = () => Number(process.env.MAX ?? 900);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Lanes run at once against the same stack; a stack off this machine is shared, so it runs one.
// The environment is resolved only when lanes are asked for: one the app cannot resolve is
// reported by session_start.
function splitLanes(caseFile: CaseFile, order: string[], wanted: number, env?: string) {
  if (wanted <= 1) return [order];
  let shared: boolean;
  try {
    const where = (env as EnvName | undefined) ?? app().defaultEnv();
    shared = !isLocalHost(new URL(app().origin(where, app().defaultApp)).hostname);
  } catch {
    shared = true;
  }
  if (shared) {
    console.log('The stack is shared or unknown: running one lane.');
    return [order];
  }
  for (const u of undeclaredUses(caseFile, order))
    console.log(`Warning: ${u.caseId} changes shared state; declare "uses": ["${u.uses}"].`);
  const lanes = planLanes(caseFile, order, wanted);
  if (lanes.length < wanted)
    console.log(`Only ${lanes.length} lane(s): the other cases share setup or state.`);
  return lanes;
}

type VerdictWait = {
  path: string;
  minutes: number;
  index: number;
  clock: ReturnType<typeof laneClock>;
  log: (line: string) => void;
};

// A new version of the file, or nothing after `minutes` without one. Every lane reads the same
// file and takes the verdicts of its own cases.
function verdictReader(wait: VerdictWait) {
  const versions = verdictVersions<VerdictFile>();
  const read = () =>
    existsSync(wait.path)
      ? { text: readFileSync(wait.path, 'utf8'), mtimeMs: statSync(wait.path).mtimeMs }
      : undefined;
  return async () => {
    wait.log(
      `Waiting for verdicts in ${wait.path} (up to ${wait.minutes} min without ` +
        'a new version; "final": true ends the wait)',
    );
    versions.startWaiting(Date.now());
    wait.clock.markReady(wait.index);
    const since = Date.now();
    while (!wait.clock.over(since, wait.minutes)) {
      const next = versions.take(read());
      if (next) return next;
      await pause(2000);
    }
    return undefined;
  };
}

// The case file as it runs, kept with the run, so a reviewer can read it while it waits.
function keepScript(runId: string, script: Record<string, unknown>): string {
  const dir = runDir(runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolvePath(dir, 'script.json'), JSON.stringify(script, null, 2));
  return resolvePath(dir, 'runner.log');
}

/** Runs a case file, in lanes where asked; answers the exit code. */
async function runCaseFileMode(
  caseFile: CaseFile,
  args: StepsArgs,
  client: Client,
  opts: StepsOptions,
): Promise<number> {
  const { flag } = args;
  const env = flag('--env');
  let selected = flag('--cases')?.split(',').filter(Boolean) ?? Object.keys(caseFile.cases);
  if (args.has('--missing')) {
    selected = await missingCases(caseFile, callerFor(client), env);
    if (selected.length === 0) {
      console.log(`Every case of ${caseFile.ticket} has a PASS on the current build.`);
      return 0;
    }
    console.log(`Missing: ${selected.join(', ')}`);
  }
  const verdictPath = process.env.WAIT_VERDICT;
  const waitMinutes = Number(flag('--wait-minutes')) || 15;
  const firstRun = Number(flag('--first-run')) || undefined;
  const branch = flag('--branch');
  // The selected cases and those they run after, in the order they run.
  const order = runOrder(caseFile, selected);
  const wanted = Math.min(Math.max(Number(flag('--lanes')) || 1, 1), MAX_LANES);
  const lanes = splitLanes(caseFile, order, wanted, env);
  const stamp = new Date().toISOString().replaceAll(/\D/g, '').slice(0, 14);
  const batch = lanes.length > 1 ? `${stamp}-${randomBytes(3).toString('hex')}` : undefined;
  const clock = laneClock(lanes.length);

  const runLane = async (laneOrder: string[], index: number) => {
    let through: Client | undefined;
    const prefix = lanes.length > 1 ? `[lane ${index + 1}] ` : '';
    // What the runner prints goes to the run's folder too, from the moment the run exists.
    let logFile: string | undefined;
    const early: string[] = [];
    const log = (line: string) => {
      if (logFile) appendFileSync(logFile, `${line}\n`);
      else early.push(line);
      const shown = prefix + line;
      console.log(shown.length > maxChars() ? `${shown.slice(0, maxChars())}…` : shown);
    };
    const laneTag = batch ? { batch, lane: index + 1 } : {};
    try {
      // Inside the try: a lane whose server does not start must still be reported and ready.
      through = index === 0 ? client : await connect(opts);
      return await runCaseFile(caseFile, callerFor(through), {
        order: laneOrder,
        log,
        ...(env ? { env } : {}),
        ...(branch ? { branch } : {}),
        ...(firstRun ? { firstRun } : {}),
        ...(batch ? { ...laneTag, define: index === 0 } : {}),
        onStarted: runId => {
          logFile = keepScript(runId, { file: caseFile, selected, order: laneOrder, ...laneTag });
          writeFileSync(logFile, early.map(l => `${l}\n`).join(''));
        },
        ...(verdictPath
          ? {
              nextVerdict: verdictReader({
                path: verdictPath,
                minutes: waitMinutes,
                index,
                clock,
                log,
              }),
            }
          : {}),
      });
    } finally {
      if (through && through !== client) await disconnect(through).catch(() => {});
    }
  };
  // A lane that fails to start must not cut the others short before their cleanup.
  const settled = await runLanes(lanes.length, i => runLane(lanes[i]!, i), {
    // Said at once: the session would otherwise wait for this lane's "waiting" line.
    failed: (i, e) => console.log(`[lane ${i + 1}] did not run: ${String(e)}`),
    ended: i => clock.markReady(i),
  });
  return settled.every(s => s.status === 'fulfilled' && s.value.runId) ? 0 : 1;
}

/** Runs a plain list of calls; after a failed step only cleanup steps run, and the run ends
 * BLOCKED. */
async function runPlainList(steps: Step[], client: Client): Promise<void> {
  // Plain lists fill only the run values, not saved data or env values.
  const vars: Vars = { values: {}, lists: {}, named: {}, env: {} };
  let stopped = '';
  for (const [name, rawArgs, stepOpts] of steps) {
    if (stopped && !isCleanup(name)) continue;
    if (name === 'sleep') {
      await pause(Number(rawArgs.seconds) * 1000);
      console.log('> sleep done');
      continue;
    }
    const wait = app().runner?.waits?.[name];
    if (wait) {
      const ms = wait(rawArgs, new Date());
      await pause(ms);
      console.log(`> ${name} done after ${Math.round(ms / 1000)} s`);
      continue;
    }
    const { out, isError } = await call(client, name, fillVars(rawArgs, vars).value);
    if (name === 'session_start') vars.TAG = String(out?.data?.runTag ?? '');
    if (!isError) capture(name, out?.data ?? {}, vars);
    console.log(
      `> ${name} ${isError ? 'ERROR' : 'ok'} ${JSON.stringify(out).slice(0, maxChars())}`,
    );
    if (isError && !stepOpts?.mayFail && !isCleanup(name))
      stopped = `${name}: ${out?.code ?? 'error'} ${out?.message ?? ''}`.slice(0, 300);
  }

  const finish = async (verdict: { verdict: string; summary: string }) => {
    for (const [name, args] of [
      ['run_finish', verdict],
      ['session_end', {}],
    ] as const) {
      const { out } = await call(client, name, args);
      console.log(`> ${name} ${JSON.stringify(out).slice(0, 200)}`);
    }
  };
  if (stopped) {
    console.log(`STOPPED at ${stopped}`);
    await finish({
      verdict: 'BLOCKED',
      summary: `Stopped at ${stopped}. Later steps were skipped; only cleanup ran.`,
    });
  } else if (process.env.WAIT_VERDICT) {
    const verdictFile = process.env.WAIT_VERDICT;
    for (let i = 0; i < 600 && !existsSync(verdictFile); i++) await pause(2000);
    await finish(await readVerdict(verdictFile));
  }
}

/** `steps <file> [flags]`: the app is set (setApp) before this runs. */
export async function runSteps(argv: string[], opts: StepsOptions): Promise<void> {
  let args: StepsArgs;
  try {
    args = parseStepsArgs(argv, app().envs);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(e.message);
    process.exit(2);
  }
  // A verdict file left from an earlier run would close this one with that run's verdict.
  if (process.env.WAIT_VERDICT && existsSync(process.env.WAIT_VERDICT)) {
    console.error(
      `WAIT_VERDICT file ${process.env.WAIT_VERDICT} already exists: delete it or pass a new path.`,
    );
    process.exit(2);
  }
  const client = await connect(opts);
  if (args.caseFile) {
    const code = await runCaseFileMode(args.caseFile, args, client, opts);
    await disconnect(client);
    process.exit(code);
  }
  await runPlainList(args.steps, client);
  await disconnect(client);
}
