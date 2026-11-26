// A small demo app the engine's tests run against: a shop with a storefront and an admin site,
// served on .localhost locally and under example.test on staging. Import this after pointing
// WITNESS_RESULTS_DIR at a scratch folder.
import { resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { setApp, type AppDefinition, type Kind } from '../../src/app.js';
import { ToolError } from '../../src/errors.js';
import { isLocalHost, normaliseHost } from '../../src/hosts.js';
import { registerCleanup } from '../../src/mcp/created.js';
import { requireSession } from '../../src/mcp/session.js';
import { defineTool } from '../../src/mcp/tool.js';

const ORIGINS: Record<string, Record<string, string>> = {
  local: { store: 'https://store.localhost:8443', admin: 'https://admin.localhost:8443' },
  staging: {
    store: 'https://store.staging.example.test',
    admin: 'https://admin.staging.example.test',
  },
};

// Each cleanup acts as one account in the storefront, so without a signed-in browser it refuses
// with NOT_LOGGED_IN before touching a page.
const CLEANUPS: [Kind, string, string][] = [
  ['order', 'orders_cleanup', 'buyer'],
  ['product', 'products_cleanup', 'seller'],
  ['coupon', 'coupons_cleanup', 'seller'],
];

function registerTools(server: McpServer) {
  for (const [kind, tool, actor] of CLEANUPS) {
    const run = async (as: string | undefined) => {
      const s = requireSession();
      s.handle(as ?? actor, 'store');
      const removed = s.created.list(kind);
      for (const item of removed) s.created.forget(kind, item);
      return { removed: removed.length, failed: [] };
    };
    registerCleanup(kind, actor, run);
    defineTool(
      server,
      tool,
      {
        title: `Remove the ${kind}s this session created`,
        description: `Removes the ${kind}s this session created. Fails with NOT_LOGGED_IN.`,
        input: z.object({}),
        destructive: true,
      },
      async () => ({ data: await run(undefined) }),
    );
  }
  defineTool(
    server,
    'order_cancel',
    {
      title: 'Cancel an order',
      description: 'Cancels an order this session placed. Fails with NOT_OWNED or NOT_LOGGED_IN.',
      input: z.object({ reference: z.string() }),
      destructive: true,
    },
    ({ reference }) => {
      const s = requireSession();
      s.created.require(
        'order',
        o => (o as { reference?: string }).reference === reference,
        () => new ToolError('NOT_OWNED', `Order ${reference} was not placed by this session.`),
      );
      s.handle('buyer', 'store');
      return { data: { cancelled: reference } };
    },
  );
}

export const demo: AppDefinition = {
  name: 'demo-ui',
  root: resolve(import.meta.dirname, '..', '..'),
  instructions: 'Drives the demo shop in a browser, through the UI only.',
  envs: ['local', 'staging'],
  apps: ['store', 'admin'],
  actors: ['buyer', 'seller', 'staff'],
  defaultApp: 'store',
  ticketExamples: ['AB-12', 'PR-34'],
  describe: {
    actor: 'Who acts: buyer, seller or staff.',
    app: 'store (the storefront) or admin.',
    env: 'local (the default) or staging.',
    cleanupAll: 'Removes what this session created, in order.',
  },
  defaultEnv: () => (process.env.DEMO_ENV === 'staging' ? 'staging' : 'local'),
  origin(env, app) {
    const origin = ORIGINS[env]?.[app];
    if (!origin) throw new Error(`No ${app} in ${env}`);
    return origin;
  },
  actorEmail: () => undefined,
  isOwnHost: host => {
    const h = normaliseHost(host);
    return isLocalHost(h) || h === 'example.test' || h.endsWith('.example.test');
  },
  isEnvHost: (env, host) =>
    env === 'local' ? isLocalHost(host) : normaliseHost(host).endsWith('.staging.example.test'),
  recognise: (_app, url) => ({ kind: new URL(url).pathname === '/' ? 'home' : 'page', url }),
  loginPageKind: 'login',
  gotoAllowed: {
    store: [/^\/$/, /^\/products(\/[\w-]+)?$/, /^\/cart$/],
    admin: [/^\/orders(\/[\w-]+)?$/],
  },
  readIdentity: () => Promise.resolve(null),
  bootstrap: { command: (actor, app, env) => `sign-in ${actor} ${app} ${env}`, runIn: '.' },
  visitor: { app: 'store', redirectHint: () => 'The storefront redirected the visitor.' },
  newState: () => ({}),
  cleanupOrder: [
    { kind: 'order', tool: 'orders_cleanup', what: 'orders', after: [] },
    { kind: 'product', tool: 'products_cleanup', what: 'products', after: ['order'] },
    { kind: 'coupon', tool: 'coupons_cleanup', what: 'coupons', after: [] },
  ],
  registerTools,
  runner: {
    waits: { waitRestock: args => Number(args.seconds ?? 1) * 1000 },
    capture: {
      product_create: [{ name: 'SKU', field: 'sku', list: true }],
      product_publish: [{ name: 'PAGE', field: 'path' }],
      cart_create: [{ name: 'CART', field: 'cartId' }],
      product_preview: [{ name: 'VER', field: 'version' }],
      order_create: [{ name: 'ORDER', field: 'orderNo' }],
    },
    sharedState: { store_setting_set: 'store-settings', staff_add: 'staff' },
  },
};

setApp(demo);
