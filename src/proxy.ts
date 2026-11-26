// The proxy an app's MCP entry starts. Kept apart from index.ts so the proxy process does not load
// the tools it restarts.
export { runProxy, type ProxyOptions } from './mcp/index.js';
