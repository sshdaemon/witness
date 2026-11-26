import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

// The viewer reads its folder at import time, so point it at a throwaway one first.
const dir = mkdtempSync(join(tmpdir(), 'witness-viewer-'));
process.env.WITNESS_RESULTS_DIR = dir;
mkdirSync(join(dir, 'runs', 'run-1', 'screenshots'), { recursive: true });
writeFileSync(join(dir, 'runs', 'run-1', 'screenshots', 'shot.png'), Buffer.from('png'));
writeFileSync(join(dir, 'runs', 'run-1', 'trace-seller-store-1.zip'), 'secret');
writeFileSync(join(dir, 'runs', 'run-1', 'steps.jsonl'), '{}');
writeFileSync(join(dir, 'secret.txt'), 'outside the run folder');

const { createViewer } = await import('../src/ui/server.js');

describe('results viewer', () => {
  let server: Server;
  let base: string;
  let port: number;

  before(async () => {
    server = createViewer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });
  after(() => server.close());

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(base + path, { headers });

  it('serves a screenshot of a run', async () => {
    const res = await get('/files/run-1/shot.png');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
  });

  it('never serves traces, logs or files outside the screenshots folder', async () => {
    for (const path of [
      '/files/run-1/trace-seller-store-1.zip',
      '/files/run-1/steps.jsonl',
      '/files/run-1/..%2fsteps.jsonl',
      '/files/run-1/..%2f..%2fsecret.txt',
      '/files/..%2f/shot.png',
      '/files/run-1/%E0%A4%A.png',
      '/files/run-1/shot.png.zip',
      '/files/nope/shot.png',
    ]) {
      assert.equal((await get(path)).status, 404, path);
    }
  });

  // fetch ignores a custom Host header, so send these by hand.
  const withHost = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/api/runs', headers: { host } },
        res => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });

  it('refuses a Host that is not loopback on this port', async () => {
    assert.equal(await withHost('evil.example'), 403);
    assert.equal(await withHost(`evil.example:${port}`), 403);
    assert.equal(await withHost(`127.0.0.1:${port + 1}`), 403);
    assert.equal(await withHost(`localhost:${port}`), 200);
  });

  it('is read only', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      assert.equal((await fetch(`${base}/api/runs`, { method })).status, 405, method);
    }
  });

  it('sends the hardening headers', async () => {
    const res = await get('/');
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  it('answers an empty store with empty lists and survives odd limits', async () => {
    assert.deepEqual(await (await get('/api/runs')).json(), []);
    for (const limit of ['-1', '1.5', 'abc', '0', '99999']) {
      assert.equal((await get(`/api/runs?limit=${limit}`)).status, 200, limit);
    }
    assert.equal((await get('/api/runs/does-not-exist')).status, 404);
    assert.equal((await get('/api/runs/..%2f..%2fetc')).status, 404);
  });
});
