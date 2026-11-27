import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import type { Client as ClientType } from '@modelcontextprotocol/client';

// The results store is chosen when paths.ts loads, so point it at a scratch folder first.
const results = mkdtempSync(join(tmpdir(), 'witness-read-'));
process.env.WITNESS_RESULTS_DIR = results;

await import('./helpers/app.js');
const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const { buildServer } = await import('../src/mcp/server.js');

// oxlint-disable-next-line typescript/no-explicit-any -- assertions read deep into the printed JSON
type Json = any;

const tsx = resolve(import.meta.dirname, '../node_modules/.bin/tsx');
const cli = resolve(import.meta.dirname, '../src/read/cli.ts');
const exec = promisify(execFile);

/** Runs the read CLI on the scratch store: its exit code and the JSON it printed. */
async function read(...args: string[]) {
  try {
    const { stdout } = await exec(tsx, [cli, ...args], {
      env: { ...process.env, WITNESS_RESULTS_DIR: results },
    });
    return { code: 0, out: JSON.parse(stdout) as Json };
  } catch (e) {
    return { code: (e as { code: number }).code, out: undefined };
  }
}

let client: ClientType;
let runId: string;

before(async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(serverSide);
  client = new Client({ name: 'read-test', version: '0.0.0' });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (
      (await client.callTool({ name, arguments: args })) as {
        structuredContent: { data: Json };
      }
    ).structuredContent.data;
  runId = (await call('session_start', { env: 'staging', ticket: 'AB-1' })).runId;
  await call('case_begin', { caseId: 'C1' });
  await call('runs_list', { limit: 1 });
  await call('case_end', { caseId: 'C1', result: 'PASS', actual: 'listed' });
  await call('run_finish', { summary: 'Read contract check.' });
  await call('session_end');
});

after(async () => {
  await client.close();
  rmSync(results, { recursive: true, force: true });
});

describe('read CLI', () => {
  it('says where the store is', async () => {
    const { out } = await read('where');
    assert.deepEqual(out, { resultsDir: results, database: join(results, 'witness.sqlite') });
  });

  it('lists runs and gives one run with its cases but no steps', async () => {
    const listed = await read('runs', '--limit', '5');
    assert.equal(listed.out[0].id, runId);
    const { out } = await read('run', runId);
    assert.equal(out.run.verdict, 'PASS');
    assert.equal(out.cases[0].caseId, 'C1');
    assert.equal(out.cases[0].result, 'PASS');
    assert.equal('steps' in out, false);
  });

  it('gives the steps in a range, with their answers', async () => {
    const { out } = await read('steps', runId, '--from', '2', '--to', '3');
    const steps = out as { seq: number; tool: string; observation: unknown }[];
    assert.deepEqual(
      steps.map(s => [s.seq, s.tool]),
      [
        [2, 'case_begin'],
        [3, 'runs_list'],
      ],
    );
    assert.ok(steps[1]!.observation);
  });

  it('gives one case, matching the ticket and case id whatever their case', async () => {
    const { out } = await read('case', 'ab-1', 'c1');
    assert.equal(out.caseId, 'C1');
    assert.equal(out.history[0].result, 'PASS');
  });

  it("gives a ticket's ledger rows", async () => {
    const { out } = await read('ledger', 'ab-1');
    assert.equal(out.results[0].case_id, 'C1');
    assert.equal(out.runs[0].run_number, 1);
  });

  it('exits 1 for a run it does not have and 2 for a wrong command', async () => {
    assert.equal((await read('run', 'nope')).code, 1);
    assert.equal((await read('nonsense')).code, 2);
    assert.equal((await read('steps', runId, '--from', 'x')).code, 2);
  });
});
