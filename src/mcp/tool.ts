import type { McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { ToolError } from '../errors.js';
import { beginFrames, endFrames } from '../browser/highlight.js';
import { app, type PageInfo } from '../app.js';
import { getSession, recordingSession } from './session.js';
import { prose } from '../prose.js';

export type ToolResult = {
  data?: unknown;
  page?: PageInfo;
  notices?: string[];
  image?: Buffer;
  screenshotPath?: string;
  earlierShots?: string[];
};

type Config<S extends z.ZodObject> = {
  title: string;
  description: string;
  input: S;
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
};

const MESSAGE_CAP = 400;

// Tools share one browser, so calls run one at a time even when the client sends them in parallel.
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

function toToolError(e: unknown): ToolError {
  if (e instanceof ToolError) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof Error && e.name === 'TimeoutError') {
    return new ToolError(
      'TIMEOUT',
      message.split('\n').filter(Boolean).slice(0, 3).join(' | ').slice(0, MESSAGE_CAP),
      'The page did not show what the tool expected. Check where_am_i and read_page.',
    );
  }
  return new ToolError('INTERNAL', message.split('\n')[0]!.slice(0, MESSAGE_CAP));
}

// Every tool answers with the same envelope and leaves one step behind in the run record.
export function defineTool<S extends z.ZodObject>(
  server: McpServer,
  name: string,
  cfg: Config<S>,
  run: (args: z.infer<S>) => ToolResult | Promise<ToolResult>,
) {
  // The SDK's generic callback types do not accept a schema-generic wrapper, so the boundary is
  // loosely typed.
  // oxlint-disable-next-line typescript/no-explicit-any
  type LooseArgs = any;
  const register = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    cb: (args: LooseArgs) => Promise<unknown>,
  ) => unknown;
  register(
    name,
    {
      title: cfg.title,
      description: cfg.description,
      inputSchema: cfg.input,
      annotations: {
        readOnlyHint: cfg.readOnly ?? false,
        destructiveHint: cfg.destructive ?? false,
        idempotentHint: cfg.idempotent ?? false,
      },
    },
    (args: z.infer<S>) =>
      serial(async () => {
        const started = Date.now();
        const notices: string[] = [];
        let envelope: Record<string, unknown>;
        let image: Buffer | undefined;
        let ok = true;
        let code: string | undefined;
        let page: PageInfo | undefined;
        let screenshotPath: string | undefined;
        let earlierShots: string[] = [];
        const open = recordingSession();
        if (open) {
          open.recorder.beginCall(name);
          beginFrames(() => open.recorder.shotPath('frame'));
        }
        getSession()?.beginCall();

        try {
          app().hooks?.beforeTool?.(getSession(), args);
          const result = await run(args);
          // A tool that acted through one page reports where it left it, unless it says otherwise.
          const used = getSession()?.usedHandle();
          page = result.page ?? (used && app().recognise(used.app, used.page.url()));
          image = result.image;
          screenshotPath = result.screenshotPath;
          earlierShots = result.earlierShots ?? [];
          notices.push(...(result.notices ?? []));
          envelope = { ok: true, page, data: result.data, notices, errors: [] };
        } catch (e) {
          ok = false;
          const err = toToolError(e);
          code = err.code;
          envelope = { ok: false, code: err.code, message: err.message, hint: err.hint };
          const session = getSession();
          const actor = (args as { actor?: never }).actor;
          if (session && (actor || session.usedHandle())) {
            try {
              // The page the call worked on, when it used one; the actor's page otherwise.
              screenshotPath = await session.screenshot(
                session.usedHandle() ?? session.findHandle(actor!, (args as { app?: never }).app),
                'fail',
              );
            } catch {
              // no page to capture
            }
          }
        }

        // Frames taken while the tool worked, then whatever it left marked, then explicit evidence
        // shots in the order taken.
        const frames = await endFrames().catch(() => [] as string[]);
        const screenshotPaths = [
          ...frames,
          ...earlierShots,
          ...(screenshotPath ? [screenshotPath] : []),
        ];

        try {
          const step = recordingSession()?.recorder.step({
            tool: name,
            title: cfg.title,
            args,
            ok,
            errorCode: code,
            pageKind: page?.kind,
            url: page?.url,
            durationMs: Date.now() - started,
            observation: envelope,
            screenshotPaths,
          });
          // The step number lets a caller tie its own checks to the recorded step.
          if (step !== undefined) envelope.step = step;
        } catch (e) {
          // The action already happened; a recording failure must not turn it into a protocol
          // error.
          notices.push(
            prose`
              Step was not recorded:
              ${e instanceof Error ? e.message.slice(0, 120) : 'unknown error'}`,
          );
        }

        const content: unknown[] = [{ type: 'text', text: JSON.stringify(envelope) }];
        if (image)
          content.push({ type: 'image', data: image.toString('base64'), mimeType: 'image/png' });
        return { content, structuredContent: envelope, isError: !ok };
      }),
  );
}
