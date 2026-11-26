import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { caseHash, parseCaseFile, runOrder, type CaseFile } from '../src/runner/caseFile.js';
import { runCaseFile, type Answer, type Caller, type VerdictFile } from '../src/runner/execute.js';
import { checkData, checkError, select } from '../src/runner/expect.js';
import { capture, fill, type Vars } from '../src/runner/fill.js';
import { buildMap, otherBuild } from '../src/runner/missing.js';

await import('./helpers/app.js');

// Answers recorded by real runs, as the store keeps them.
// oxlint-disable-next-line typescript/no-explicit-any -- recorded answers of many tools
const real: Record<string, any> = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/observations.json'), 'utf8'),
);

const passes = (e: Parameters<typeof checkData>[0], data: unknown) => checkData(e, data, 7).ok;

describe('expects on recorded answers', () => {
  const product = real.product.data;
  const order = real.order.data;
  const exp = real.export.data;

  it('reads paths with indexes, [*] and [field=value]', () => {
    assert.deepEqual(select(product, 'variants[0].stock[0].left').values, ['0 in stock']);
    assert.deepEqual(select(product, 'variants[*].backorder'), {
      values: ['allowed'],
      many: true,
      found: true,
    });
    assert.deepEqual(select(product, 'variants[name=Default].listed').values, ['yes']);
    assert.deepEqual(select(product, 'variants[name=Other].listed').values, []);
    assert.deepEqual(select(product, 'variants[3].name').values, []);
  });

  it('checks equals, contains, excludes, matches, count and exists', () => {
    assert.ok(passes({ path: 'variants[0].stock[0].left', equals: '0 in stock' }, product));
    assert.ok(!passes({ path: 'variants[0].stock[0].left', equals: '1 in stock' }, product));
    assert.ok(passes({ path: 'variants[*].backorder', contains: 'allow' }, product));
    assert.ok(passes({ path: 'status', contains: 'pack' }, order));
    assert.ok(passes({ path: 'formatsOffered', contains: 'JSON' }, exp));
    assert.ok(passes({ path: 'formatsOffered', excludes: 'PDF' }, exp));
    assert.ok(!passes({ path: 'formatsOffered', excludes: 'CSV' }, exp));
    assert.ok(passes({ path: 'headers', contains: 'Order total' }, exp));
    assert.ok(passes({ path: 'reference', matches: '^\\d{7}$' }, order));
    assert.ok(passes({ path: 'items', count: 1 }, order));
    assert.ok(passes({ path: 'variants[*].stock', count: 1 }, product));
    assert.ok(passes({ path: 'rowCount', equals: 1 }, exp));
    assert.ok(
      passes({ path: 'couponApplied', exists: false }, order),
      'null is what was not shown',
    );
    assert.ok(passes({ path: 'orderNotes', exists: true }, order), 'an empty list is there');
    assert.ok(passes({ path: 'missing', exists: false }, order));
    assert.ok(!passes({ path: 'missing', equals: 'x' }, order), 'nothing picked never equals');
    // A misspelled key is not an empty list.
    assert.ok(!passes({ path: 'typeOffered', excludes: 'PDF' }, exp));
    assert.ok(!passes({ path: 'item', count: 0 }, order));
    assert.ok(!passes({ path: 'variants[4].stock', count: 0 }, product));
    assert.equal(checkData({ path: 'item', count: 0 }, order, 1).got, 'path not found');
    assert.ok(passes({ path: 'orderNotes', count: 0 }, order), 'an empty list behind a real key');
    assert.ok(
      passes({ path: 'variants[name=Other]', count: 0 }, product),
      'a filter that picks nothing',
    );
    assert.ok(passes({ path: 'orderNotes', excludes: 'x' }, order));
  });

  it('reports what it found, and refuses a path it cannot read', () => {
    const c = checkData({ path: 'variants[*].backorder', equals: 'Off' }, product, 7);
    assert.deepEqual(c, {
      seq: 7,
      path: 'variants[*].backorder',
      check: 'equals',
      want: 'Off',
      got: ['allowed'],
      ok: false,
    });
    assert.equal(checkData({ path: 'a..b', exists: true }, product, 1).check, 'path');
  });

  it('checks a refusal read back as data, and a refusal that fails the call', () => {
    assert.ok(checkData({ path: 'reason', contains: 'clashes' }, real.couponRefused.data, 3).ok);
    const refused = real.formatRefused;
    assert.ok(checkError({ error: 'FORMAT_NOT_AVAILABLE' }, { isError: true, ...refused }, 4).ok);
    assert.ok(
      checkError(
        { error: 'FORMAT_NOT_AVAILABLE', message: 'not an export format' },
        { isError: true, ...refused },
        4,
      ).ok,
    );
    assert.ok(!checkError({ error: 'OTHER' }, { isError: true, ...refused }, 4).ok);
    const passed = checkError({ error: 'FORMAT_NOT_AVAILABLE' }, { isError: false }, 4);
    assert.equal(passed.ok, false);
    assert.equal(passed.got, 'succeeded');
  });
});

describe('placeholders', () => {
  const vars: Vars = {
    TAG: 'r8w2fn',
    values: {},
    lists: { SKU: ['L1', 'L2'] },
    named: { capped4: { id: 'uuid-1', slug: 'r8w2fn-capped4', qty: 4 } },
    env: { store: 'Northwind Store' },
  };

  it('fills run values, saved data and env values, keeping a whole value as it is', () => {
    const { value, missing } = fill(
      {
        product: '{{capped4.slug}}',
        qty: '{{capped4.qty}}',
        id: '{{SKU2}}',
        name: '{{TAG}} c12 {{capped4.qty}} in stock',
        nested: [{ store: '{{env.store}}' }],
      },
      vars,
    );
    assert.deepEqual(missing, []);
    assert.deepEqual(value, {
      product: 'r8w2fn-capped4',
      qty: 4,
      id: 'L2',
      name: 'r8w2fn c12 4 in stock',
      nested: [{ store: 'Northwind Store' }],
    });
  });

  it('lists placeholders with no value and leaves them', () => {
    const { value, missing } = fill(
      { a: '{{other.id}}', b: 'x {{PAGE}}', c: '{{env.none}}' },
      vars,
    );
    assert.deepEqual(missing.toSorted(), ['PAGE', 'env.none', 'other.id']);
    assert.equal(value.b, 'x {{PAGE}}');
  });

  it("keeps the values the app's tools leave: the last of each, every one of a list", () => {
    const run: Vars = { values: {}, lists: {}, named: {}, env: {} };
    capture('product_create', { sku: 'L1' }, run);
    capture('product_create', { sku: 'L2' }, run);
    capture('product_publish', { path: 'first' }, run);
    capture('product_publish', { path: 'second' }, run);
    capture('order_create', { orderNo: 'B7' }, run);
    capture('cart_create', { cartId: '' }, run);
    capture('product_preview', { version: null }, run);
    capture('read_page', { path: 'not kept' }, run);
    const { value, missing } = fill(
      { a: '{{SKU1}}', b: '{{SKU2}}', c: '{{PAGE}}', d: '{{ORDER}}', e: '{{CART}}', f: '{{VER}}' },
      run,
    );
    assert.deepEqual(value, {
      a: 'L1',
      b: 'L2',
      c: 'second',
      d: 'B7',
      e: '{{CART}}',
      f: '{{VER}}',
    });
    assert.deepEqual(missing.toSorted(), ['CART', 'VER']);
  });
});

const file = (cases: CaseFile['cases'], extra: Partial<CaseFile> = {}): CaseFile => ({
  ticket: 'AB-1',
  topic: 'Runner tests',
  cases,
  ...extra,
});
const read = (name: string, extra: Record<string, unknown> = {}) =>
  [name, { purpose: 'verify', ...extra }] as [string, Record<string, unknown>];

describe('case files', () => {
  it('refuses unknown fixtures and cases, loops and malformed expects', () => {
    const one = { title: 't', block: [read('r')] };
    assert.throws(
      () => parseCaseFile(file({ C1: { ...one, needs: ['nope'] } })),
      /needs fixture nope/,
    );
    assert.throws(() => parseCaseFile(file({ C1: { ...one, after: ['C9'] } })), /not a case/);
    assert.throws(
      () => parseCaseFile(file({ C1: { ...one, after: ['C2'] }, C2: { ...one, after: ['C1'] } })),
      /loop \(C1 → C2 → C1\)/,
    );
    assert.throws(
      () =>
        parseCaseFile(
          file({
            C1: {
              title: 't',
              block: [['r', {}, { expect: [{ path: 'a', equals: 1, count: 1 }] }]],
            },
          }),
        ),
      /exactly one of/,
    );
    assert.throws(
      () => parseCaseFile({ ticket: 'AB-1', topic: 'x', cases: {}, extra: 1 }),
      /Not a valid/,
    );
    assert.throws(
      () =>
        parseCaseFile(
          file({ C1: { title: 't', block: [read('r')] } }, { setup: [['store_setting_set', {}]] }),
        ),
      /setup holds plain login calls only/,
    );
    assert.throws(
      () =>
        parseCaseFile(
          file(
            { C1: { title: 't', block: [read('r')] } },
            { setup: [['login', { actor: 'buyer' }, { as: 'buyer' }]] },
          ),
        ),
      /nothing saved by "as"/,
    );
    assert.throws(
      () => parseCaseFile(file({ 'C1 rules': { title: 't', block: [read('r')] } })),
      /cases\.C1 rules/,
    );
    assert.throws(
      () =>
        parseCaseFile(
          file({
            C1: { title: 't', steps: Array.from({ length: 31 }, () => 's'), block: [read('r')] },
          }),
        ),
      /Not a valid/,
    );
  });

  it('runs the selected cases after the cases they depend on', () => {
    const one = { title: 't', block: [read('r')] };
    const f = file({
      C1: one,
      C2: { ...one, after: ['C3'] },
      C3: one,
      C4: { ...one, after: ['C2'] },
    });
    assert.deepEqual(runOrder(f, ['C4']), ['C3', 'C2', 'C4']);
    assert.deepEqual(runOrder(f, ['C1', 'C2', 'C3', 'C4']), ['C1', 'C3', 'C2', 'C4']);
  });
});

describe('case versions', () => {
  it('change with the case and with the fixtures it needs, not with others', () => {
    const c = { title: 't', needs: ['a'], block: [read('r')] };
    const base = caseHash(c, { a: [['x', {}]], b: [['y', {}]] });
    assert.equal(caseHash(c, { a: [['x', {}]], b: [['z', {}]] }), base);
    assert.notEqual(caseHash(c, { a: [['x', { n: 2 }]], b: [['y', {}]] }), base);
    assert.notEqual(caseHash({ ...c, title: 'u' }, { a: [['x', {}]] }), base);
  });
});

describe('builds', () => {
  it('compares only the apps both runs had', () => {
    const a = buildMap({ store: { sha: 's1' }, admin: { sha: 'a1' } });
    assert.equal(otherBuild(a, buildMap({ store: { sha: 's1' }, other: { sha: 'o9' } })), false);
    assert.equal(otherBuild(a, buildMap({ store: { sha: 's2' } })), true);
    assert.equal(otherBuild(a, buildMap({ store: { sha: 's1', dirty: true } })), true);
    assert.equal(otherBuild(a, new Map()), false);
  });
});

/** A server stand-in: records each call and answers from a script of tool results. */
function fakeServer(answers: Record<string, (args: Record<string, unknown>) => Answer>) {
  const calls: [string, Record<string, unknown>][] = [];
  let step = 0;
  const call: Caller = async (name, args) => {
    calls.push([name, args]);
    step++;
    const base: Answer = { isError: false, out: { ok: true, data: {}, step } };
    if (name === 'session_start')
      return {
        isError: false,
        out: {
          data: { runId: 'run-1', runTag: 'r8w2fn', env: 'local', label: 'AB-1 run 4' },
          step,
        },
      };
    const a = answers[name]?.(args);
    return a ? { ...a, out: { ...a.out, step } } : base;
  };
  return { call, calls };
}
const ok = (data: Record<string, unknown>): Answer => ({ isError: false, out: { ok: true, data } });
const err = (code: string, message = 'refused'): Answer => ({
  isError: true,
  out: { ok: false, code, message },
});

const versions = (list: VerdictFile[]) => {
  let i = 0;
  return async () => list[i++];
};

describe('running a case file', () => {
  const f = file(
    {
      C1: {
        title: 'Stock read back',
        needs: ['product'],
        block: [
          ['order_create', { product: '{{product.slug}}', name: '{{TAG}} mug' }],
          [
            ...read('stock', { productId: '{{product.id}}' }),
            { expect: [{ path: 'left', equals: '4 left' }] },
          ] as never,
        ],
      },
      C10: {
        title: 'Expect names a run value',
        needs: ['product'],
        block: [['stock', {}, { expect: [{ path: 'product', equals: '{{product.slug}}' }] }]],
      },
      C2: {
        title: 'Fails its check',
        block: [['stock', {}, { expect: [{ path: 'left', equals: '9 left' }] }]],
      },
      C3: {
        title: 'After a failed case',
        after: ['C2'],
        block: [['stock', {}, { expect: [{ path: 'left', exists: true }] }]],
      },
      C4: {
        title: 'Tool error',
        block: [
          ['broken', {}],
          ['stock', {}],
        ],
      },
      C5: { title: 'After a blocked case', after: ['C4'], block: [['stock', {}]] },
      C6: { title: 'Needs a failing fixture', needs: ['bad'], block: [['stock', {}]] },
      C7: { title: 'Needs an env value', block: [['stock', { store: '{{env.paidStore}}' }]] },
      C8: { title: 'Read without an expect', block: [read('stock')] },
      C11: {
        title: 'After a case waiting for its verdict',
        after: ['C8'],
        block: [['stock', {}]],
      },
      C9: {
        title: 'Refused as it should be',
        block: [['broken', {}, { expect: { error: 'BROKEN' } }]],
      },
    },
    {
      env: { local: { store: 'Northwind' } },
      fixtures: {
        product: [
          ['product_create', { name: 'capped' }, { as: 'product' }],
          ['product_publish', { id: '{{product.id}}' }, { as: 'product' }],
        ],
        bad: [['product_create', { name: 'bad' }, { expect: [{ path: 'id', equals: 'other' }] }]],
      },
    },
  );

  it('records each case, stops only what depends on a failure, takes the verdict', async () => {
    const { call, calls } = fakeServer({
      product_create: () => ok({ id: 'L1' }),
      product_publish: () => ok({ slug: 'r8w2fn-capped' }),
      stock: () => ok({ left: '4 left', product: 'r8w2fn-capped' }),
      broken: () => err('BROKEN'),
      cleanup_all: () => ok({ left: [] }),
      run_finish: () => ok({ verdict: 'FAIL' }),
    });
    const lines: string[] = [];
    const r = await runCaseFile(parseCaseFile(f), call, {
      order: runOrder(f, Object.keys(f.cases)),
      log: l => lines.push(l),
      // The session corrects C11 in a second version and then says it is final.
      nextVerdict: versions([
        { cases: { C8: { result: 'PASS', actual: '4 left' }, C11: { result: 'FAIL', note: 'x' } } },
        {
          cases: { C8: { result: 'PASS', actual: '4 left' }, C11: { result: 'PASS' } },
          final: true,
        },
      ]),
    });
    assert.deepEqual(
      r.outcomes.map(o => [o.caseId, o.result, o.judgedBy]),
      [
        ['C1', 'PASS', 'checks'],
        ['C10', 'PASS', 'checks'],
        ['C2', 'FAIL', 'checks'],
        ['C3', 'PASS', 'checks'],
        ['C4', 'BLOCKED', 'session'],
        ['C5', 'NOT_RUN', 'session'],
        ['C6', 'NOT_RUN', 'session'],
        ['C7', 'NOT_RUN', 'session'],
        ['C8', 'PASS', 'session'],
        ['C11', 'PASS', 'session'],
        ['C9', 'PASS', 'checks'],
      ],
    );
    const notes = Object.fromEntries(r.outcomes.map(o => [o.caseId, o.note]));
    assert.match(notes.C4!, /^broken: BROKEN refused/);
    assert.match(notes.C5!, /runs after C4, which was blocked/);
    assert.match(notes.C6!, /fixture bad failed: id equals "other", found "L1"/);
    assert.match(notes.C7!, /env local has no paidStore/);

    // The fixture is built once, before the first case that needs it, outside any case.
    const names = calls.map(c => c[0]);
    assert.deepEqual(names.slice(0, 6), [
      'session_start',
      'cases_define',
      'product_create',
      'product_publish',
      'case_begin',
      'order_create',
    ]);
    const order = calls.find(c => c[0] === 'order_create')![1];
    assert.deepEqual(order, { product: 'r8w2fn-capped', name: 'r8w2fn mug' });
    // C4 stopped at its failing call; C5 to C7 never began.
    const begun = calls.filter(c => c[0] === 'case_begin').map(c => c[1].caseId);
    assert.deepEqual(begun, ['C1', 'C10', 'C2', 'C3', 'C4', 'C8', 'C11', 'C9']);
    // Each version is applied once; an unchanged verdict is not sent again.
    const c11 = calls
      .filter(c => c[0] === 'case_end' && c[1].caseId === 'C11')
      .map(c => c[1].result);
    assert.deepEqual(c11, ['BLOCKED', 'FAIL', 'PASS']);
    assert.equal(notes.C11, undefined, 'the FAIL note does not stay on the PASS');
    const c1End = calls.find(c => c[0] === 'case_end' && c[1].caseId === 'C1')![1];
    assert.equal((c1End.checks as { seq: number }[])[0]!.seq, 7, 'checks carry the recorded step');
    assert.equal(typeof c1End.caseHash, 'string');
    // C8 waited for the session, which then judged it.
    const c8 = calls.filter(c => c[0] === 'case_end' && c[1].caseId === 'C8').map(c => c[1].result);
    assert.deepEqual(c8, ['BLOCKED', 'PASS']);
    assert.deepEqual(names.slice(-2), ['run_finish', 'session_end']);
    assert.match(r.summary, /FAIL: C2 left equals "9 left", found "4 left"/);
    assert.match(r.summary, /NOT RUN: C5/);
    assert.ok(lines.some(l => l.includes('✕ left equals "9 left", found "4 left"')));
  });

  it('closes a case whose result the server refused, so the next case can begin', async () => {
    let refused = false;
    const { call, calls } = fakeServer({
      stock: () => ok({ left: '4 left' }),
      case_end: args => {
        if (!refused && args.judgedBy === 'checks') {
          refused = true;
          return err('INVALID', 'checks too long');
        }
        return ok({});
      },
    });
    const two = file({
      C1: {
        title: 'a',
        block: [['stock', {}, { expect: [{ path: 'left', exists: true }] }]],
      },
      C2: {
        title: 'b',
        block: [['stock', {}, { expect: [{ path: 'left', exists: true }] }]],
      },
    });
    const r = await runCaseFile(two, call, { order: ['C1', 'C2'], log: () => {} });
    assert.deepEqual(
      r.outcomes.map(o => [o.caseId, o.result]),
      [
        ['C1', 'BLOCKED'],
        ['C2', 'PASS'],
      ],
    );
    assert.match(r.outcomes[0]!.note!, /not recorded: INVALID checks too long/);
    const c1Ends = calls.filter(c => c[0] === 'case_end' && c[1].caseId === 'C1');
    assert.equal(c1Ends.length, 2);
  });

  it('runs the setup first, and runs no case when it fails', async () => {
    const { call, calls } = fakeServer({
      login: () => err('SESSION_MISSING', 'sign in once'),
      stock: () => ok({ left: '4 left' }),
    });
    const withSetup = file(
      { C1: { title: 'a', block: [['stock', {}]] }, C2: { title: 'b', block: [['stock', {}]] } },
      { setup: [['login', { actor: 'seller' }]] },
    );
    const r = await runCaseFile(withSetup, call, { order: ['C1', 'C2'], log: () => {} });
    assert.deepEqual(
      r.outcomes.map(o => [o.caseId, o.result, o.note]),
      [
        ['C1', 'NOT_RUN', 'setup failed: login: SESSION_MISSING sign in once'],
        ['C2', 'NOT_RUN', 'setup failed: login: SESSION_MISSING sign in once'],
      ],
    );
    assert.deepEqual(
      calls.slice(0, 3).map(c => c[0]),
      ['session_start', 'cases_define', 'login'],
    );
    assert.ok(!calls.some(c => c[0] === 'case_begin'));
  });

  it('closes an unjudged case BLOCKED with no verdict when none comes', async () => {
    const { call } = fakeServer({ stock: () => ok({ left: '4 left' }) });
    const only = file({ C8: { title: 'Read without an expect', block: [read('stock')] } });
    const r = await runCaseFile(only, call, { order: ['C8'], log: () => {} });
    assert.equal(r.outcomes[0]!.result, 'BLOCKED');
    assert.equal(r.outcomes[0]!.note, 'no verdict');
  });
});
