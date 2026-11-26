import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Client as ClientType } from '@modelcontextprotocol/client';
import type { Caller } from '../src/runner/execute.js';

// The results store is chosen when paths.ts loads, so point it at a scratch folder first.
const results = mkdtempSync(join(tmpdir(), 'witness-runner-'));
process.env.WITNESS_RESULTS_DIR = results;

const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');
await import('./helpers/app.js');
const { buildServer } = await import('../src/mcp/server.js');
const { parseCaseFile, runOrder } = await import('../src/runner/caseFile.js');
const { runCaseFile } = await import('../src/runner/execute.js');
const { missingCases } = await import('../src/runner/missing.js');
let client: ClientType;
const call: Caller = async (name, args) => {
  const res = (await client.callTool({ name, arguments: args })) as {
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  return { isError: !!res.isError, out: (res.structuredContent ?? {}) as never };
};

before(async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(serverSide);
  client = new Client({ name: 'runner-test', version: '0.0.0' });
  await client.connect(clientSide);
});
after(async () => {
  await client.close();
  rmSync(results, { recursive: true, force: true });
});

// Tools that need no browser stand in for the product: runs_list reads, run_get refuses.
const file = parseCaseFile({
  ticket: 'AB-77',
  topic: 'AB-77 Runner through the server',
  cases: {
    C1: {
      title: 'A read checked by its expects',
      block: [
        [
          'runs_list',
          { ticket: 'AB-77' },
          { expect: [{ path: 'runs[0].label', equals: 'AB-77 run 1' }] },
        ],
      ],
    },
    C2: {
      title: 'A refusal expected',
      block: [['run_get', { id: 'nope' }, { expect: { error: 'RUN_NOT_FOUND' } }]],
    },
    C3: { title: 'A refusal not expected', block: [['run_get', { id: 'nope' }]] },
    C4: { title: 'Runs after C3', after: ['C3'], block: [['runs_list', {}]] },
  },
});

describe('a case file through the server', () => {
  it('records cases against their steps, numbers the run, verdict from cases', async () => {
    const r = await runCaseFile(file, call, {
      order: runOrder(file, Object.keys(file.cases)),
      env: 'staging',
      log: () => {},
    });
    assert.deepEqual(
      r.outcomes.map(o => [o.caseId, o.result]),
      [
        ['C1', 'PASS'],
        ['C2', 'PASS'],
        ['C3', 'BLOCKED'],
        ['C4', 'NOT_RUN'],
      ],
    );
    const got = (await call('run_get', { id: r.runId! })).out.data as {
      run: { verdict: string; label: string; ticket: string };
      cases: {
        caseId: string;
        result: string;
        steps: { from: number; to: number } | null;
        checks: { seq: number }[];
      }[];
    };
    assert.equal(got.run.verdict, 'BLOCKED');
    assert.equal(got.run.label, 'AB-77 run 1');
    const c1 = got.cases.find(c => c.caseId === 'C1')!;
    assert.deepEqual(c1.steps, { from: 3, to: 5 }, 'case_begin, the read, case_end');
    assert.equal(c1.checks[0]!.seq, 4, 'the check names the read it was made on');
    assert.equal(got.cases.find(c => c.caseId === 'C4')!.steps, null);
  });

  it('stores the case definitions and reruns only what is missing', async () => {
    const known = (await call('ticket_cases', { ticket: 'ab-77' })).out.data as {
      cases: { caseId: string; title: string; latest: { result: string } | null }[];
    };
    assert.deepEqual(
      known.cases.map(c => [c.caseId, c.latest?.result]),
      [
        ['C1', 'PASS'],
        ['C2', 'PASS'],
        ['C3', 'BLOCKED'],
        ['C4', 'NOT_RUN'],
      ],
    );
    assert.equal(known.cases[0]!.title, 'A read checked by its expects');
    assert.deepEqual(await missingCases(file, call, 'staging'), ['C3', 'C4']);
    const local = (await call('ticket_cases', { ticket: 'AB-77', env: 'local' })).out.data as {
      cases: { latest: unknown }[];
    };
    assert.ok(
      local.cases.every(c => c.latest === null),
      'a PASS on staging says nothing about local',
    );

    // A changed case is a new version, so it needs a run again.
    const changed = parseCaseFile({
      ...file,
      cases: { ...file.cases, C2: { ...file.cases.C2!, title: 'A refusal expected, reworded' } },
    });
    assert.deepEqual(await missingCases(changed, call, 'staging'), ['C2', 'C3', 'C4']);
  });
});
