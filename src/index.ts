// What an app builds on: its definition, its tools and their helpers, and the worker that serves
// them. App code imports the engine only from here (and the proxy from proxy.ts), so everything
// else in the engine can change without touching an app.

// The app definition and the worker that serves it.
export { setApp, type AppDefinition, type Build, type CleanupStep, type Kinds } from './app.js';
export { runWorker } from './mcp/worker.js';

// Tools: the envelope, errors, input schemas and wording.
export { defineTool } from './mcp/tool.js';
export { ToolError } from './errors.js';
export { hhmm, realDate } from './mcp/schemas.js';
export { prose } from './prose.js';

// The session a tool acts in, and what it created.
export { requireSession, type Handle, type Session } from './mcp/session.js';
export { cleanupOrderText, registerCleanup } from './mcp/created.js';
export { hasSession } from './mcp/guards.js';

// Browser helpers for page objects.
export { frame, mark, ROW_ATTR, seen } from './browser/highlight.js';
export { settle, untilStable } from './browser/settle.js';
export { HttpLog, watchServerFailures, type HttpRead } from './browser/failures.js';

// Hosts and paths an app's config builds on.
export { isLocalHost, normaliseHost } from './hosts.js';
export { identityFile, RESULTS_DIR, sessionFile } from './paths.js';
