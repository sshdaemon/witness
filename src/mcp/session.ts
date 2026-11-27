import { runName } from './names.js';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import {
  app as appDef,
  type ActorName,
  type AppName,
  type AppSession,
  type Builds,
  type EnvName,
  type Identity,
  type SessionState,
} from '../app.js';
import { identityFile, sessionFile } from '../paths.js';
import { ToolError } from '../errors.js';
import { capture, shot } from '../browser/highlight.js';
import { settle } from '../browser/settle.js';
import { HttpLog } from '../browser/failures.js';
import { hasSession, installHostGuard } from './guards.js';
import { Created } from './created.js';
import { Recorder } from './recorder.js';
import { prose } from '../prose.js';

export type Handle = {
  /** visitor: the app's visitor site with no one signed in. */
  actor: ActorName | 'visitor';
  app: AppName;
  context: BrowserContext;
  page: Page;
  consoleErrors: string[];
  http: HttpLog;
};

export class Session implements AppSession {
  readonly tag = randomBytes(3).toString('hex');
  /**
   * Who the run is for (ticket or PR and run number), put after the tag in the names the tools
   * make.
   */
  label?: string;
  readonly runId: string;
  readonly recorder: Recorder;
  readonly builds: Builds;
  private browser?: Promise<Browser>;
  private handles = new Map<string, Handle>();
  /** Everything this session created, for ownership checks and cleanup. */
  readonly created = new Created();
  private appState?: SessionState;
  /** What the app keeps for this session. */
  get state(): SessionState {
    return (this.appState ??= appDef().newState());
  }
  /** What the app's start hook said the caller should know. */
  readonly startNotices: string[];
  /** What the app's end hook added to session_end's answer. */
  endReport: { data?: Record<string, unknown>; notices?: string[] } = {};

  constructor(
    readonly env: EnvName,
    readonly headed: boolean,
    /** Keep the browser traces even when the run passes. */
    readonly trace = false,
    about: {
      title?: string;
      branch?: string;
      kind?: string;
      ticket?: string;
      label?: string;
      firstRun?: number;
      batch?: string;
      lane?: number;
    } = {},
    start: { builds: Builds; notices: string[] } = { builds: {}, notices: [] },
  ) {
    const stamp = new Date().toISOString().replaceAll(/[-:T]/g, '').slice(0, 14);
    this.runId = `${stamp}-${this.tag}`;
    this.builds = start.builds;
    this.startNotices = start.notices;
    this.recorder = new Recorder(this.runId, env, this.tag, about, this.builds);
    // With a ticket and no label, the run is labelled "<ticket> run <n>".
    this.label = this.recorder.label;
  }

  /** A name for something this run creates: tag, label, then the words, within max characters. */
  name(words = '', max?: number, opts?: { keepWords?: boolean }): string {
    return runName(this.tag, this.label, words, max, opts);
  }

  actorsWithSession() {
    const out: string[] = [];
    const { actors, apps } = appDef();
    for (const actor of actors) {
      for (const a of apps) {
        if (hasSession(sessionFile(appDef().root, this.env, actor, a))) out.push(`${actor}:${a}`);
      }
    }
    return out;
  }

  private launch(): Promise<Browser> {
    const channel = process.env.WITNESS_BROWSER_CHANNEL || undefined;
    this.browser ??= chromium.launch({ headless: !this.headed, channel });
    return this.browser;
  }

  /**
   * Handles a tool asked for during the current call, so the envelope can say where it left the
   * page.
   */
  private used = new Set<Handle>();

  beginCall() {
    this.used.clear();
  }

  /** The one handle the current call acted through, if it used exactly one. */
  usedHandle(): Handle | undefined {
    return this.used.size === 1 ? [...this.used][0] : undefined;
  }

  handle(actor: ActorName, app: AppName): Handle {
    const h = this.handles.get(`${actor}:${app}`);
    if (!h)
      throw new ToolError(
        'NOT_LOGGED_IN',
        `${actor} has no open ${app} session.`,
        `Call login({ actor: "${actor}", app: "${app}" }) first.`,
      );
    this.used.add(h);
    return h;
  }

  findHandle(actor: ActorName, app?: AppName): Handle {
    if (app) return this.handle(actor, app);
    const open = [...this.handles.values()].filter(h => h.actor === actor);
    if (open.length === 0)
      throw new ToolError(
        'NOT_LOGGED_IN',
        `${actor} has no open session.`,
        `Call login({ actor: "${actor}" }) first.`,
      );
    if (open.length > 1)
      throw new ToolError(
        'AMBIGUOUS_APP',
        `${actor} has more than one app open.`,
        `Pass app: ${open.map(h => h.app).join(' or ')}.`,
      );
    this.used.add(open[0]!);
    return open[0]!;
  }

  async login(actor: ActorName, appName: AppName): Promise<{ identity: Identity; handle: Handle }> {
    const def = appDef();
    const origin = def.origin(this.env, appName);
    const file = sessionFile(appDef().root, this.env, actor, appName);
    const bootstrap = def.bootstrap.command(actor, appName, this.env);
    if (!hasSession(file)) {
      throw new ToolError(
        'SESSION_MISSING',
        `No saved ${actor}/${appName} session for ${this.env}.`,
        `Run once in a terminal: ${bootstrap}`,
      );
    }

    const key = `${actor}:${appName}`;
    const existing = this.handles.get(key);
    const handle = existing ?? (await this.openContext(actor, appName, origin, file));
    try {
      await handle.page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
      await settle(handle.page);
      let identity: Identity | null = null;
      for (let i = 0; i < 20 && !identity?.uid; i++) {
        identity = await def.readIdentity(handle.page);
        if (!identity?.uid) await handle.page.waitForTimeout(500);
      }
      const kind = def.recognise(appName, handle.page.url()).kind;
      if (!identity?.uid || kind === def.loginPageKind) {
        throw new ToolError(
          'SESSION_EXPIRED',
          `The saved ${actor}/${appName} session was rejected.`,
          `Re-run: ${bootstrap}`,
        );
      }

      // The signed-in user may carry no email, so the session is tied to the uid recorded at
      // sign-in.
      const idFile = identityFile(appDef().root, this.env, actor, appName);
      const known = existsSync(idFile)
        ? (JSON.parse(readFileSync(idFile, 'utf8')) as { uid: string; email: string | null })
        : undefined;
      if (known && known.uid !== identity.uid) {
        throw new ToolError(
          'ACCOUNT_MISMATCH',
          prose`
            The ${actor}/${appName} session belongs to a different account than the one signed in
            at bootstrap.`,
        );
      }
      const expected = def.actorEmail(actor, this.env);
      if (expected && identity.email && identity.email.toLowerCase() !== expected) {
        throw new ToolError(
          'ACCOUNT_MISMATCH',
          `Session is ${identity.email}, expected ${expected}.`,
        );
      }
      if (!known)
        writeFileSync(
          idFile,
          JSON.stringify({
            uid: identity.uid,
            email: identity.email ?? expected ?? null,
            savedAt: new Date().toISOString(),
          }),
          { mode: 0o600 },
        );
      this.handles.set(key, handle);
      return {
        identity: { uid: identity.uid, email: identity.email ?? known?.email ?? expected ?? null },
        handle,
      };
    } catch (e) {
      // A context that failed the identity checks must never serve later tool calls.
      this.handles.delete(key);
      await this.stopTrace(handle);
      await handle.context.close().catch(() => {});
      throw e;
    }
  }

  private async openContext(
    actor: Handle['actor'],
    app: AppName,
    origin: string,
    file?: string,
  ): Promise<Handle> {
    const browser = await this.launch();
    const context = await browser.newContext({
      ...(file && { storageState: file }),
      baseURL: origin,
      ignoreHTTPSErrors: this.env === 'local',
      viewport: { width: 1280, height: 900 },
    });
    await installHostGuard(context, this.env);
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on('pageerror', e => consoleErrors.push(e.message));
    page.on('console', m => m.type() === 'error' && consoleErrors.push(m.text()));
    return { actor, app, context, page, consoleErrors, http: new HttpLog(page) };
  }
  /**
   * The app with no one signed in, as a visitor sees it: a context with no saved session, checked
   * to carry no signed-in user. The app may prepare it first (gate cookies that sign no one in).
   */
  async visitor(): Promise<Handle> {
    const { visitor, origin: originOf, readIdentity } = appDef();
    const key = `visitor:${visitor.app}`;
    let handle = this.handles.get(key);
    if (!handle) {
      const origin = originOf(this.env, visitor.app);
      handle = await this.openContext('visitor', visitor.app, origin);
      try {
        await visitor.prepare?.(handle.context, this.env);
        await handle.page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
        await settle(handle.page);
        if (new URL(handle.page.url()).origin !== origin) {
          throw new ToolError(
            'ACCESS_GATE',
            `The visitor was sent to ${new URL(handle.page.url()).host} instead of the site.`,
            visitor.redirectHint(this.env),
          );
        }
        if ((await readIdentity(handle.page))?.uid) {
          throw new ToolError(
            'NOT_SIGNED_OUT',
            'A fresh browser with no saved session came up signed in.',
            'Something signs the site in by itself; check the page with read_page.',
          );
        }
      } catch (e) {
        await this.stopTrace(handle);
        await handle.context.close().catch(() => {});
        throw e;
      }
      this.handles.set(key, handle);
    }
    this.used.add(handle);
    return handle;
  }

  async logout(actor: ActorName, app: AppName) {
    const key = `${actor}:${app}`;
    const h = this.handles.get(key);
    if (h) {
      await this.stopTrace(h);
      await h.context.close();
      this.handles.delete(key);
    }
  }

  /** A screenshot named after the current step and `label` ("0007-orders_read-verify.png"). */
  async screenshot(h: Handle, label: string): Promise<string> {
    const path = this.recorder.shotPath(label);
    // With elements marked by the tool, the shot shows them in yellow; otherwise it is the plain
    // page.
    if (!(await capture(h.page, path))) await shot(h.page, { path });
    return path;
  }

  /** The element alone, with the marked parts in yellow; the whole page when nothing is marked. */
  async elementShot(h: Handle, label: string, within: Locator): Promise<string> {
    if (await within.count()) {
      const path = this.recorder.shotPath(label);
      if (await capture(h.page, path, within.first())) return path;
    }
    return this.screenshot(h, label);
  }

  private traces = 0;

  /**
   * Traces are kept only when something went wrong (or the run asked for them): they are most of
   * the disk a run uses.
   */
  keepTrace(): boolean {
    const v = this.recorder.verdict;
    return this.trace || this.recorder.failed() || (v !== undefined && v !== 'PASS');
  }

  // Every trace is written when its context closes: whether the run needs it is known only once the
  // run is over.
  private async stopTrace(h: Handle) {
    const path = resolve(this.recorder.dir, `trace-${h.actor}-${h.app}-${++this.traces}.zip`);
    await h.context.tracing.stop({ path }).catch(() => {});
    if (existsSync(path)) this.recorder.addTrace(path);
  }

  async end(): Promise<void> {
    for (const h of this.handles.values()) {
      await this.stopTrace(h);
      await h.context.close().catch(() => {});
    }
    this.handles.clear();
    if (!this.keepTrace()) this.recorder.dropTraces();
    await (await this.browser)?.close().catch(() => {});
    this.browser = undefined;
  }
}

let current: Session | undefined;
let lastEnded: Session | undefined;
export const getSession = () => current;
// The session to record a step on: the open one, or the one that just ended (so session_end is
// recorded too).
export const recordingSession = () => current ?? lastEnded;
export function requireSession(): Session {
  if (!current)
    throw new ToolError('NO_SESSION', 'No session is open.', 'Call session_start first.');
  return current;
}
export async function startSession(opts: {
  env?: EnvName;
  headed?: boolean;
  trace?: boolean;
  title?: string;
  branch?: string;
  kind?: string;
  label?: string;
  ticket: string;
  firstRun?: number;
  batch?: string;
  lane?: number;
}): Promise<Session> {
  if (current)
    throw new ToolError(
      'SESSION_OPEN',
      `Session ${current.runId} is still open.`,
      'Call session_end first.',
    );
  lastEnded = undefined;
  const def = appDef();
  const env = opts.env ?? def.defaultEnv();
  const start = (await def.hooks?.sessionStart?.(env)) ?? { builds: {}, notices: [] };
  current = new Session(
    env,
    opts.headed ?? false,
    opts.trace ?? false,
    {
      title: opts.title,
      branch: opts.branch,
      kind: opts.kind,
      ticket: opts.ticket,
      label: opts.label,
      firstRun: opts.firstRun,
      batch: opts.batch,
      lane: opts.lane,
    },
    start,
  );
  return current;
}
export async function endSession(verdictIfOpen: 'ABORTED' = 'ABORTED') {
  const s = current;
  if (!s) return undefined;
  try {
    s.endReport = (await appDef().hooks?.beforeSessionEnd?.(s)) ?? {};
  } catch (e) {
    // The run record and the browsers must still close.
    console.error(`[${appDef().name}] the session end hook failed:`, e);
  }
  s.recorder.closeOpenCase('The session ended before case_end');
  if (!s.recorder.verdict) s.recorder.finish(verdictIfOpen, 'Session ended without run_finish');
  await s.end();
  current = undefined;
  lastEnded = s;
  return s;
}
