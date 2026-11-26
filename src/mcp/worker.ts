import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { pruneOldRuns, retentionDays, sweepAbandonedRuns } from './retention.js';
import { closeStore } from './store.js';
import { endSession } from './session.js';
import { buildServer } from './server.js';
import { app } from '../app.js';
import { prose } from '../prose.js';

/** Serves the app's tools over stdio; the app must be set first. */
export function runWorker() {
  const { name } = app();

  // Results hold screenshots of test accounts' pages, so they are kept for a limited time only.
  try {
    const aborted = sweepAbandonedRuns();
    if (aborted.length > 0)
      console.error(`[${name}] recorded ${aborted.length} abandoned runs as ABORTED`);
    const { runs, folders } = pruneOldRuns();
    if (runs.length > 0 || folders.length > 0)
      console.error(
        prose`
          [${name}] removed ${runs.length} runs and ${folders.length} run folders past their
          retention (${retentionDays()} days for tests)`,
      );
  } catch (e) {
    console.error(`[${name}] could not remove old results:`, e);
  }

  const handle = serveStdio(() => buildServer(), { onerror: e => console.error(`[${name}]`, e) });

  // A stray rejection must never end the process: that would lose the record of what to clean up.
  process.on('unhandledRejection', reason =>
    console.error(`[${name}] unhandled rejection:`, reason),
  );

  // stdin end and a signal can both arrive; the shutdown runs once.
  let closing: Promise<void> | undefined;
  const shutdown = () =>
    (closing ??= (async () => {
      await endSession();
      await handle.close();
      closeStore();
      process.exit(0);
    })());
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);
}
