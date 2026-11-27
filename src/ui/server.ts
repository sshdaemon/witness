import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prose } from '../prose.js';
import { clientBundle } from './bundle.js';
import {
  caseDetail,
  evidence,
  evidenceFile,
  runDetail,
  runs,
  screenshotFile,
  ticketDetail,
  tickets,
  type Links,
} from '../read/index.js';

const PORT = Number(process.env.WITNESS_PORT) || 4477;
const PUBLIC_DIR = resolve(import.meta.dirname, 'public');
const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/logo.png': { file: 'logo.png', type: 'image/png' },
};

// Shoelace's own self-contained build: the viewer serves it, as its policy allows no other origin.
const SHOELACE_DIR = resolve(
  dirname(fileURLToPath(import.meta.resolve('@shoelace-style/shoelace'))),
  '..',
  'cdn',
);
const VENDOR_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** A file of Shoelace's build, only inside its folder and only of the types above. */
function vendorFile(path: string): { file: string; type: string } | undefined {
  const type = VENDOR_TYPES[extname(path)];
  if (!type || !/^[\w./-]+$/.test(path) || path.split('/').includes('..')) return undefined;
  const file = resolve(SHOELACE_DIR, path);
  if (!file.startsWith(SHOELACE_DIR + sep) || !existsSync(file) || !statSync(file).isFile())
    return undefined;
  return { file, type };
}

const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

const sendPng = (res: ServerResponse, file: string | undefined) => {
  if (!file) return json(res, { error: 'not found' }, 404);
  res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' });
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
};

async function sendBundle(res: ServerResponse) {
  try {
    const code = await clientBundle();
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(code);
  } catch (e) {
    console.error(e);
    json(res, { error: 'the viewer code did not build' }, 500);
  }
}

// The viewer serves files itself, from these addresses.
const URLS: Links = {
  shot: (runId, name) => `/files/${runId}/${name}`,
  evidence: row => `/evidence-files/${row.id}`,
};

export function createViewer(): Server {
  const server: Server = createServer((req, res) => {
    try {
      handle(req, res, (server.address() as AddressInfo).port);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) json(res, { error: 'internal error' }, 500);
      else res.end();
    }
  });
  return server;
}

function handle(req: IncomingMessage, res: ServerResponse, port: number) {
  // Only the loopback names are accepted, which also defeats DNS rebinding.
  const host = (req.headers.host ?? '').toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
    return json(res, { error: 'bad host' }, 403);
  if (req.method !== 'GET') return json(res, { error: 'read only' }, 405);

  // Shoelace fetches its built-in icons as data: URLs, which can carry nothing out.
  res.setHeader(
    'content-security-policy',
    prose`
      default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src
      'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');

  const url = new URL(req.url ?? '/', `http://${host}`);
  const asset = STATIC[url.pathname];
  if (asset) {
    res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
    return res.end(readFileSync(resolve(PUBLIC_DIR, asset.file)));
  }
  if (url.pathname === '/app.js') return void sendBundle(res);
  if (url.pathname.startsWith('/vendor/shoelace/')) {
    const vendor = vendorFile(url.pathname.slice('/vendor/shoelace/'.length));
    if (!vendor) return json(res, { error: 'not found' }, 404);
    res.writeHead(200, { 'content-type': vendor.type, 'cache-control': 'max-age=86400' });
    return createReadStream(vendor.file)
      .on('error', () => res.destroy())
      .pipe(res);
  }
  if (url.pathname === '/api/runs') {
    const q = url.searchParams;
    const filter = { ticket: q.get('ticket'), env: q.get('env'), verdict: q.get('verdict') };
    return json(res, runs({ ...filter, limit: q.get('limit') }));
  }
  if (url.pathname === '/api/evidence') return json(res, evidence(URLS));
  if (url.pathname === '/api/tickets') return json(res, tickets());
  const ticketPath = /^\/api\/tickets\/([^/]+)(?:\/cases\/([^/]+))?$/.exec(url.pathname);
  if (ticketPath) {
    let ticket: string, caseId: string | undefined;
    try {
      ticket = decodeURIComponent(ticketPath[1]!);
      caseId = ticketPath[2] === undefined ? undefined : decodeURIComponent(ticketPath[2]);
    } catch {
      return json(res, { error: 'not found' }, 404);
    }
    const body = caseId === undefined ? ticketDetail(ticket) : caseDetail(ticket, caseId, URLS);
    return body ? json(res, body) : json(res, { error: 'not found' }, 404);
  }
  const picked = /^\/evidence-files\/(\d+)$/.exec(url.pathname);
  if (picked) return sendPng(res, evidenceFile(Number(picked[1])));
  const detail = /^\/api\/runs\/([0-9a-z-]+)$/.exec(url.pathname);
  if (detail) {
    const body = runDetail(detail[1]!, { links: URLS });
    return body ? json(res, body) : json(res, { error: 'not found' }, 404);
  }
  const file = /^\/files\/([0-9a-z-]+)\/([^/]+)$/.exec(url.pathname);
  if (file) {
    let name: string;
    try {
      name = decodeURIComponent(file[2]!);
    } catch {
      return json(res, { error: 'not found' }, 404);
    }
    return sendPng(res, screenshotFile(file[1]!, name));
  }
  json(res, { error: 'not found' }, 404);
}

// Start only when run directly, so tests can build a viewer on a free port.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createViewer().listen(PORT, '127.0.0.1', () =>
    console.log(`witness results: http://127.0.0.1:${PORT}`),
  );
}
