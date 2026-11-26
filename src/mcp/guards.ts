import { existsSync } from 'node:fs';
import type { BrowserContext } from 'playwright';
import { app, type AppName, type EnvName } from '../app.js';
import { ToolError } from '../errors.js';

const DATA_TYPES = new Set(['document', 'fetch', 'xhr', 'websocket', 'eventsource']);

// Backstop on top of config: an app host outside the current environment (production, or staging
// while on local) is refused for page loads, data calls and any write. Plain GET assets such as
// images and fonts still load.
export async function installHostGuard(context: BrowserContext, env: EnvName) {
  const { isOwnHost, isEnvHost } = app();
  const outside = (host: string) => isOwnHost(host) && !isEnvHost(env, host);

  await context.route(
    url => outside(url.hostname),
    route => {
      const req = route.request();
      const readOnlyAsset =
        !DATA_TYPES.has(req.resourceType()) && ['GET', 'HEAD'].includes(req.method());
      return readOnlyAsset ? route.fallback() : route.abort('blockedbyclient');
    },
  );
  await context.routeWebSocket(
    url => outside(url.hostname),
    ws => ws.close(),
  );
}

export function assertGotoAllowed(appName: AppName, route: string): URL {
  const url = new URL(route, 'http://placeholder');
  if (!(app().gotoAllowed[appName] ?? []).some(re => re.test(url.pathname))) {
    throw new ToolError(
      'ROUTE_NOT_ALLOWED',
      `${url.pathname} is not an allowed ${appName} route.`,
      'Use a semantic tool for this.',
    );
  }
  return url;
}

export const hasSession = (file: string) => existsSync(file);
