import { runLabel } from './names.js';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { app as appDef, type AppName, type EnvName } from '../app.js';
import { ToolError } from '../errors.js';
import { shot } from '../browser/highlight.js';
import { settle, stableSnapshot } from '../browser/settle.js';
import { assertGotoAllowed } from './guards.js';
import {
  endSession,
  getSession,
  recordingSession,
  requireSession,
  startSession,
} from './session.js';
import { getRun, listRuns } from './store.js';
import { caseOpenError, caseResultsFor, verdictFromCases } from './cases.js';
import { registerCaseTools, ticketExamples, ticketId } from './caseTools.js';
import { buildReport } from './report.js';
import { registerEvidenceTools } from './evidenceTools.js';
import { cleanupFor, cleanupOrderText } from './created.js';
import { defineTool } from './tool.js';
import { prose } from '../prose.js';

const SNAPSHOT_CAP = { concise: 6000, detailed: 20_000 };

const pageOf = (appName: AppName, url: string) => appDef().recognise(appName, url);

export function buildServer(): McpServer {
  const def = appDef();
  const actor = z.enum(def.actors).describe(def.describe.actor);
  const app = z.enum(def.apps).optional().describe(def.describe.app);
  const appOrDefault = z.enum(def.apps).default(def.defaultApp);
  const server = new McpServer(
    { name: def.name, version: '0.0.1' },
    { capabilities: { tools: {} }, instructions: def.instructions },
  );

  defineTool(
    server,
    'session_start',
    {
      title: 'Start a test session',
      description: prose`
          Opens a run record and returns a run tag. Say what you are testing in topic, and pass
          the ticket: the store gives the run the ticket's next number and labels it '<ticket>
          run <n>', so every name the tools make reads '<tag> <label> <what it is>'. Pass label
          only for a run without a ticket (for example 'PR 42 run 1'). The tools put namePrefix
          (the tag, then the label) in front of the names and messages they build; a name a tool
          uses exactly as given (a person's first name) should start with it, so rows from earlier
          runs are never confused with yours and screenshots say what they show. Call before
          login.`,
      input: z.object({
        topic: z
          .string()
          .trim()
          .min(3)
          .max(120)
          .describe(
            prose`
              What is being tested, for example 'provider filter on the search page'. Runs
              are grouped by it.`,
          ),
        branch: z.string().max(120).optional().describe('The branch under test, for the record.'),
        kind: z
          .enum(['test', 'tool'])
          .optional()
          .describe(
            prose`
              test (default): checking a feature. tool: only exercising or developing an MCP
              tool, kept apart in the results viewer.`,
          ),
        env: z.enum(def.envs).optional().describe(def.describe.env),
        headed: z.boolean().optional().describe('Show the browser window.'),
        trace: z
          .boolean()
          .optional()
          .describe(
            prose`
              Keep the Playwright traces even if the run passes. By default they are kept only
              for a run with a failed step or a verdict other than PASS.`,
          ),
        label: runLabel.optional(),
        ticket: ticketId()
          .optional()
          .describe(
            prose`
              The ticket or pull request whose cases this run tests, for example
              ${ticketExamples()}. The run gets the ticket's next run number, and the label
              '<ticket> run <n>' unless label is given.`,
          ),
        firstRun: z
          .number()
          .int()
          .min(1)
          .max(999)
          .optional()
          .describe(
            prose`
              With ticket, the lowest number this run may get: one more than the last run
              numbered by hand in the ticket's QA ledger. Needed once, for a ticket tested before
              runs were numbered.`,
          ),
        batch: z
          .string()
          .regex(/^[0-9a-z-]{6,40}$/)
          .optional()
          .describe(
            prose`
              With ticket, the batch of parallel lanes this run belongs to (the steps runner sets
              it): every lane of a batch shares one run number and is labelled '<ticket> run <n>
              lane <lane>'.`,
          ),
        lane: z.number().int().min(1).max(9).optional().describe("This run's lane in its batch."),
      }),
    },
    async ({ env, topic, branch, kind, headed, trace, label, ticket, firstRun, batch, lane }) => {
      const s = await startSession({
        env: env as EnvName | undefined,
        topic,
        branch,
        kind,
        headed,
        trace,
        label,
        ticket,
        firstRun,
        batch,
        lane,
      });
      return {
        data: {
          runId: s.runId,
          runTag: s.tag,
          label: s.label ?? null,
          ticket: s.recorder.ticket ?? null,
          runNumber: s.recorder.runNumber ?? null,
          namePrefix: s.name(),
          env: s.env,
          builds: s.builds,
          savedSessions: s.actorsWithSession(),
        },
        notices: s.startNotices,
      };
    },
  );

  defineTool(
    server,
    'run_finish',
    {
      title: 'Record the verdict of the run',
      description: prose`
          Closes the run with PASS, FAIL or BLOCKED. Use BLOCKED when a precondition cannot be
          reached through the UI. Base the verdict only on reader output, never on a screenshot.
          A run that recorded cases takes its verdict from them (any FAIL, else any BLOCKED or
          NOT_RUN, else PASS): leave verdict out, or give the same one. Fails with CASE_OPEN while
          a case has no case_end, VERDICT_REQUIRED for a run without cases and no verdict, and
          VERDICT_MISMATCH when the verdict given is not the one its cases give. Call before
          session_end.`,
      input: z.object({
        verdict: z.enum(['PASS', 'FAIL', 'BLOCKED']).optional(),
        summary: z
          .string()
          .describe('One or two sentences: what was verified or what stopped the run.'),
        firstFailureStep: z.number().int().optional(),
      }),
    },
    ({ verdict, summary, firstFailureStep }) => {
      const s = requireSession();
      const open = s.recorder.openCaseId();
      if (open) throw caseOpenError(open);
      const fromCases = verdictFromCases(s.runId);
      if (fromCases && verdict && verdict !== fromCases)
        throw new ToolError(
          'VERDICT_MISMATCH',
          `The run's cases give ${fromCases}, not ${verdict}.`,
          'Leave verdict out, or change the case that disagrees with case_end.',
        );
      const final = fromCases ?? verdict;
      if (!final)
        throw new ToolError(
          'VERDICT_REQUIRED',
          'This run recorded no cases, so it needs a verdict.',
          'Pass verdict: PASS, FAIL or BLOCKED.',
        );
      s.recorder.finish(final, summary, firstFailureStep);
      return {
        data: { runId: s.runId, verdict: final, cases: fromCases ? caseResultsFor(s.runId) : [] },
      };
    },
  );

  defineTool(
    server,
    'session_end',
    {
      title: 'End the test session',
      description: prose`
          Closes the browsers, saves the traces and returns where the evidence is. A run without
          run_finish is stored as ABORTED.`,
      input: z.object({}),
    },
    async () => {
      const s = await endSession();
      if (!s) throw new ToolError('NO_SESSION', 'No session is open.');
      const leftBehind = s.created.pending().map(p => ({ tool: p.tool, count: p.count }));
      return {
        data: {
          runId: s.runId,
          dir: s.recorder.dir,
          stepLog: s.recorder.stepLogPath,
          leftBehind,
          ...s.endReport.data,
        },
        notices: [
          ...(s.endReport.notices ?? []),
          ...(leftBehind.length > 0
            ? [
                prose`
                  Not cleaned up: ${leftBehind.map(p => `${p.count} for ${p.tool}`).join(', ')}.
                  The browsers are closed, so these stay on the stack.`,
              ]
            : []),
        ],
      };
    },
  );

  defineTool(
    server,
    'cleanup_all',
    {
      title: 'Clean up everything this session created',
      description: prose`
        Runs every *_cleanup that has something left, in the order they must run:
        ${cleanupOrderText()}. ${def.describe.cleanupAll} A cleanup that fails, or whose account
        is not logged in, is reported under its tool name; a later one that depends on it is
        skipped while those records remain, and the rest still run. Returns each cleanup's result
        and what is left. Call before run_finish.`,
      input: z.object({}),
      destructive: true,
      idempotent: true,
    },
    async () => {
      const s = requireSession();
      const results: Record<string, unknown> = {};
      for (const p of s.created.pending()) {
        // Removing a parent record first would strand what still hangs off it.
        const waiting = p.after.filter(k => s.created.blocking(k) > 0);
        if (waiting.length > 0) {
          results[p.tool] = {
            skipped: prose`
              waits for
              ${waiting.map(k => def.cleanupOrder.find(c => c.kind === k)!.tool).join(', ')}`,
          };
          continue;
        }
        const cleanup = cleanupFor(p.kind);
        if (!cleanup) {
          results[p.tool] = {
            error: 'NO_CLEANUP',
            message: `No cleanup is registered for ${p.what}.`,
          };
          continue;
        }
        try {
          results[p.tool] = await cleanup.run(cleanup.actor);
        } catch (e) {
          results[p.tool] = {
            error: e instanceof ToolError ? e.code : 'INTERNAL',
            message: e instanceof Error ? e.message.split('\n')[0] : String(e),
          };
        }
      }
      const left = s.created.pending().map(p => ({ tool: p.tool, count: p.count }));
      return {
        data: { results, left },
        notices:
          left.length > 0
            ? [`Still left: ${left.map(p => `${p.count} for ${p.tool}`).join(', ')}.`]
            : [],
      };
    },
  );

  defineTool(
    server,
    'runs_list',
    {
      title: 'List earlier runs',
      description: prose`
          Run history from the results store, newest first. Filter by topic, ticket, environment
          or verdict.`,
      input: z.object({
        topic: z.string().optional(),
        ticket: ticketId().optional(),
        env: z.enum(def.envs).optional(),
        verdict: z.enum(['PASS', 'FAIL', 'BLOCKED', 'ABORTED']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      readOnly: true,
      idempotent: true,
    },
    filter => ({ data: { runs: listRuns(filter) } }),
  );

  defineTool(
    server,
    'run_get',
    {
      title: 'Get one earlier run',
      description: prose`
        A run with its steps (paged, 50 by default), artifact paths (screenshots, traces) and the
        result of each case it ran, with the steps each case covered and its checks.`,
      input: z.object({
        id: z.string(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      readOnly: true,
      idempotent: true,
    },
    ({ id, limit, offset }) => {
      const run = getRun(id, { limit, offset });
      if (!run) throw new ToolError('RUN_NOT_FOUND', `No run ${id}.`);
      return { data: run };
    },
  );

  defineTool(
    server,
    'report',
    {
      title: 'Markdown report of a run or a topic',
      description: prose`
          Raw notes for drafting a ticket or pull request comment when asked, not for pasting as
          is: the verdict, what was checked, the builds served and any failed steps. Pass runId
          for one run, or topic for its latest runs. Defaults to the run in progress or just
          ended.`,
      input: z.object({
        runId: z.string().optional(),
        topic: z.string().optional(),
        last: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('With topic: how many latest runs to include (default 3).'),
      }),
      readOnly: true,
      idempotent: true,
    },
    ({ runId, topic, last }) => {
      const id = runId ?? (topic ? undefined : (getSession() ?? recordingSession())?.runId);
      if (!id && !topic)
        throw new ToolError('NOTHING_TO_REPORT', 'No run in progress.', 'Pass runId or topic.');
      const markdown = buildReport({ runId: id, topic, last });
      if (!markdown) throw new ToolError('RUN_NOT_FOUND', `Nothing recorded for ${id ?? topic}.`);
      return { data: { markdown } };
    },
  );

  defineTool(
    server,
    'login_bootstrap',
    {
      title: 'How to create a saved sign-in',
      description: prose`
          A Google sign-in cannot be done by the agent. This returns the one-time command a
          person runs in a terminal; afterwards login works from the saved session.`,
      input: z.object({ actor, app: z.enum(def.apps) }),
      readOnly: true,
      idempotent: true,
    },
    ({ actor: a, app: ap }) => {
      const env = getSession()?.env ?? def.defaultEnv();
      return { data: { command: def.bootstrap.command(a, ap, env), runIn: def.bootstrap.runIn } };
    },
  );

  defineTool(
    server,
    'login',
    {
      title: 'Sign in as an actor',
      description: prose`
          Restores the actor's saved Google-backed session in a fresh browser context, opens the
          app and confirms who is signed in. Safe to repeat. Returns SESSION_MISSING or
          SESSION_EXPIRED with the command to fix it.`,
      input: z.object({ actor, app: appOrDefault }),
      idempotent: true,
    },
    async ({ actor: a, app: ap }) => {
      const s = requireSession();
      const { identity, handle } = await s.login(a, ap);
      return {
        page: pageOf(ap, handle.page.url()),
        data: { actor: a, app: ap, email: identity.email },
      };
    },
  );

  defineTool(
    server,
    'logout',
    {
      title: "Close an actor's browser context",
      description: prose`
          Closes the actor's browser context for this session. The saved sign-in file is kept, so
          login works again.`,
      input: z.object({ actor, app: appOrDefault }),
      idempotent: true,
    },
    async ({ actor: a, app: ap }) => {
      const session = requireSession();
      def.hooks?.beforeLogout?.(session, a, ap);
      await session.logout(a, ap);
      return { data: { actor: a, app: ap, closed: true } };
    },
  );

  defineTool(
    server,
    'viewport_set',
    {
      title: "Resize an actor's browser window",
      description: prose`
          Sets the width and height of the actor's open page, as a phone, tablet or desktop
          screen would be, and reloads nothing: the page reacts as it would to a resized window.
          Reads back the size the page reports (innerWidth, innerHeight). The size lasts until
          logout or the next viewport_set; a fresh login starts at 1280 by 900. Fails with
          VIEWPORT_NOT_SET when the page reports another size.`,
      input: z.object({
        actor,
        app: appOrDefault,
        width: z.number().int().min(320).max(2560),
        height: z.number().int().min(480).max(1600).default(900),
      }),
      idempotent: true,
    },
    async ({ actor: a, app: ap, width, height }) => {
      const { page } = requireSession().handle(a, ap);
      await page.setViewportSize({ width, height });
      const shown = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      if (shown.width !== width || shown.height !== height)
        throw new ToolError(
          'VIEWPORT_NOT_SET',
          `The page reports ${shown.width} by ${shown.height}, not ${width} by ${height}.`,
          'Retry viewport_set.',
        );
      return { data: { actor: a, app: ap, ...shown } };
    },
  );

  defineTool(
    server,
    'where_am_i',
    {
      title: 'Where is this actor in the product?',
      description:
        "Recognised page kind, URL, title and the signed-in identity for an actor's open page.",
      input: z.object({ actor, app }),
      readOnly: true,
      idempotent: true,
    },
    async ({ actor: a, app: ap }) => {
      const h = requireSession().findHandle(a, ap);
      const identity = await def.readIdentity(h.page);
      return {
        page: pageOf(h.app, h.page.url()),
        data: { title: await h.page.title(), email: identity?.email ?? null },
      };
    },
  );

  defineTool(
    server,
    'read_page',
    {
      title: 'Read the current page as text',
      description: prose`
          Accessibility-tree text of the actor's page, trimmed. Prefer a semantic reader when one
          exists. Set purpose to verify when this read is the evidence for a Then step, so a
          screenshot is kept.`,
      input: z.object({
        actor,
        app,
        format: z.enum(['concise', 'detailed']).default('concise'),
        purpose: z.enum(['explore', 'verify']).default('explore'),
      }),
      readOnly: true,
      idempotent: true,
    },
    async ({ actor: a, app: ap, format, purpose }) => {
      const s = requireSession();
      const h = s.findHandle(a, ap);
      const full = await stableSnapshot(h.page);
      const cap = SNAPSHOT_CAP[format];
      const screenshotPath = purpose === 'verify' ? await s.screenshot(h, 'verify') : undefined;
      return {
        page: pageOf(h.app, h.page.url()),
        data: {
          title: await h.page.title(),
          snapshot: full.slice(0, cap),
          truncated: full.length > cap,
        },
        screenshotPath,
      };
    },
  );

  defineTool(
    server,
    'goto',
    {
      title: 'Open a known route',
      description:
        "Navigates the actor's page to an allowed route of the app. Unknown routes are refused.",
      input: z.object({
        actor,
        app: appOrDefault,
        route: z.string().describe('Path such as /products or /login.'),
      }),
      idempotent: true,
    },
    async ({ actor: a, app: ap, route }) => {
      const s = requireSession();
      const h = s.handle(a, ap);
      const url = assertGotoAllowed(ap, route);
      await h.page.goto(new URL(url.pathname + url.search, h.page.url()).toString(), {
        waitUntil: 'domcontentloaded',
      });
      await settle(h.page);
      return { page: pageOf(ap, h.page.url()) };
    },
  );

  defineTool(
    server,
    'screenshot',
    {
      title: 'Take a screenshot (debug only)',
      description:
        "A PNG of the actor's page. Use read_page for evidence; screenshots are for debugging.",
      input: z.object({ actor, app }),
      readOnly: true,
    },
    async ({ actor: a, app: ap }) => {
      const s = requireSession();
      const h = s.findHandle(a, ap);
      const path = await s.screenshot(h, 'shot');
      return {
        page: pageOf(h.app, h.page.url()),
        data: { path },
        image: await shot(h.page),
        screenshotPath: path,
      };
    },
  );

  defineTool(
    server,
    'console_errors',
    {
      title: 'Browser console errors',
      description: 'Page errors and console errors since the page was opened, last 50.',
      input: z.object({ actor, app }),
      readOnly: true,
      idempotent: true,
    },
    ({ actor: a, app: ap }) => {
      const h = requireSession().findHandle(a, ap);
      return { page: pageOf(h.app, h.page.url()), data: { errors: h.consoleErrors.slice(-50) } };
    },
  );

  defineTool(
    server,
    'http_failures',
    {
      title: 'Failed HTTP requests of the open page',
      description: prose`
        The data requests to the app's own and local hosts (page loads, fetch and XHR; not images,
        scripts or third-party calls) the actor's browser made since it was opened by login or
        the last clear. Returns since (start of the log), requests (finished requests matching
        the filter), failed (answered with a status of 400 or more, or with no response:
        method, URL, status or error, time), aborted (requests the browser cancelled itself,
        for example when a page was left mid-load; not app failures) and notKept (older
        requests dropped past 1000). urlContains counts only requests whose URL contains that
        text, for example "/filters", so "requests 0" says the page never asked for it. A read
        with requests 0 and no urlContains means nothing was watched yet, not that nothing
        failed. clear empties the log after reading, so the next read covers only the steps
        after it.
        Fails with NOT_LOGGED_IN or AMBIGUOUS_APP (pass app).`,
      input: z.object({
        actor,
        app,
        urlContains: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('Only requests whose URL contains this text, e.g. "/search".'),
        clear: z.boolean().default(false).describe('Empty the log after this read.'),
      }),
      readOnly: true,
    },
    ({ actor: a, app: ap, urlContains, clear }) => {
      const h = requireSession().findHandle(a, ap);
      const data = { ...h.http.read(urlContains), ...(urlContains ? { urlContains } : {}) };
      if (clear) h.http.clear();
      return { page: pageOf(h.app, h.page.url()), data };
    },
  );

  def.registerTools(server);
  registerEvidenceTools(server);
  registerCaseTools(server);

  return server;
}
