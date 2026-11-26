// What an app's own tests reach for beyond the public entry: the server without a transport, the
// record of what a session created, the current session, the route allowlist check, and the
// screenshot frames and HTTP failure summary its page objects feed.
export { buildServer } from './mcp/server.js';
export { cleanupFor, Created } from './mcp/created.js';
export { assertGotoAllowed } from './mcp/guards.js';
export { getSession } from './mcp/session.js';
export { beginFrames, endFrames } from './browser/highlight.js';
export { summarise, type HttpEntry } from './browser/failures.js';
