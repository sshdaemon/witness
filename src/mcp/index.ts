import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Server, type CallToolResult, type Tool } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { prose } from '../prose.js';

/** The server's name, the worker file that sets the app and calls runWorker, and the app's
 * checkout the worker runs in. */
export type ProxyOptions = { name: string; worker: string; root: string };

// The tools run in a child process, so mcp_reload can restart it with edited code while this
// process keeps the connection to the client.
let options: ProxyOptions;
// The worker's own shutdown (app hooks, traces, browsers) can take longer than the SDK's
// close, which kills the process after 4 s.
const STOP_TIMEOUT = 60_000;

const reloadTool = (name: string): Tool => ({
  name: 'mcp_reload',
  title: `Reload the ${name} tools`,
  description: prose`
    Restarts the process that runs the ${name} tools, so edits to them take effect without
    reconnecting. Call it after run_finish and session_end: the old process ends like a server
    shutdown, so an open session is ended and a run without run_finish is stored as ABORTED.
    Returns the number of tools; the tool list is announced as changed. A change to the server
    instructions (such as a new cleanup kind) still needs a reconnect (/mcp); the result says so.
    Fails with WORKER_START_FAILED (the edited code does not start; fix it and call again).`,
  inputSchema: { type: 'object', properties: {} },
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
});

function noop() {}

type Worker = { client: Client; exited: Promise<void> };
let worker: Worker | undefined;
let pending: Promise<Worker> | undefined;

async function startWorker(): Promise<Worker> {
  // node itself, not the tsx wrapper, so signals reach the process that runs the tools.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', options.worker],
    cwd: options.root,
    env: process.env as Record<string, string>,
    stderr: 'inherit',
  });
  const client = new Client({ name: `${options.name}-proxy`, version: '0.0.1' });
  let markExited: () => void = noop;
  const exited = new Promise<void>(resolve => {
    markExited = resolve;
  });
  const started: Worker = { client, exited };
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  client.onclose = () => {
    markExited();
    if (worker === started) {
      worker = undefined;
      console.error(
        `[${options.name} proxy] the tools process ended; the next call starts it again`,
      );
    }
  };
  await client.connect(transport);
  return started;
}

/** One start or restart at a time; every call waits for it. */
function settle(step: () => Promise<Worker>): Promise<Worker> {
  // Chained on the previous start or restart, so two never run at once.
  const run = (pending ?? Promise.resolve())
    .catch(() => undefined)
    .then(step)
    .then(started => (worker = started));
  pending = run;
  run
    .finally(() => {
      if (pending === run) pending = undefined;
    })
    .catch(() => {});
  return run;
}

function ready(): Promise<Worker> {
  if (pending) return pending;
  if (worker) return Promise.resolve(worker);
  return settle(startWorker);
}

/** Ends the worker's stdin and lets its shutdown finish before the transport is closed. */
async function stopWorker(old: Worker | undefined) {
  if (!old) return;
  const transport = old.client.transport as StdioClientTransport | undefined;
  // @ts-expect-error the SDK keeps the child process private; ending stdin is a normal shutdown
  transport?._process?.stdin?.end();
  await Promise.race([old.exited, new Promise(resolve => setTimeout(resolve, STOP_TIMEOUT))]);
  await old.client.close();
}

const envelope = (body: object, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(body) }],
  structuredContent: body as Record<string, unknown>,
  isError,
});

/** Serves the MCP connection and runs the tools in a worker process it can restart. */
export async function runProxy(opts: ProxyOptions) {
  options = opts;
  const reload = reloadTool(opts.name);
  const first = await ready();
  const instructions = first.client.getInstructions();

  const handle = serveStdio(
    () => {
      const server = new Server(
        { name: options.name, version: '0.0.1' },
        { capabilities: { tools: { listChanged: true } }, instructions },
      );

      server.setRequestHandler('tools/list', async () => {
        const { tools } = await (await ready()).client.listTools();
        return { tools: [...tools, reload] };
      });

      server.setRequestHandler('tools/call', async (request, ctx) => {
        if (request.params.name !== reload.name) {
          // No timeout of its own: the client's timeout applies, and its cancel is passed on.
          const { client } = await ready();
          return client.callTool(request.params, {
            timeout: 2 ** 31 - 1,
            signal: ctx.mcpReq.signal,
          });
        }
        try {
          await settle(async () => {
            const old = worker;
            worker = undefined;
            await stopWorker(old);
            return startWorker();
          });
          // A later reload may already have replaced the worker this one started.
          const fresh = await ready();
          const { tools } = await fresh.client.listTools();
          await server.sendToolListChanged();
          const notices =
            fresh.client.getInstructions() === instructions
              ? []
              : ['The server instructions changed; reconnect (/mcp) to load them.'];
          return envelope({ ok: true, data: { tools: tools.length }, notices, errors: [] });
        } catch (e) {
          return envelope(
            {
              ok: false,
              code: 'WORKER_START_FAILED',
              message: `The tools process did not start: ${e instanceof Error ? e.message : e}`,
              hint: 'Fix the code (typecheck, then the error on stderr) and call mcp_reload again.',
            },
            true,
          );
        }
      });

      return server;
    },
    { onerror: e => console.error(`[${options.name} proxy]`, e) },
  );

  process.on('unhandledRejection', reason =>
    console.error(`[${options.name} proxy] unhandled rejection:`, reason),
  );

  let closing: Promise<void> | undefined;
  const shutdown = () =>
    (closing ??= (async () => {
      await stopWorker(worker);
      await handle.close();
      process.exit(0);
    })());
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);
}
