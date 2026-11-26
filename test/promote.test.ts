import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCaseFile } from '../src/runner/caseFile.js';
import { newSuite, promote } from '../src/runner/promote.js';

await import('./helpers/app.js');

const read = (path: string, extra: Record<string, unknown> = {}) =>
  [path, { purpose: 'verify', ...extra }, { expect: [{ path: 'x', exists: true }] }] as never;

const source = parseCaseFile({
  ticket: 'AB-70',
  topic: 'AB-70 Shared product',
  setup: [['login', { actor: 'seller' }]],
  env: { local: { storeId: 'c-local', unused: 'u' }, staging: { storeId: 'c-staging' } },
  fixtures: {
    product: [['product_create', { name: 'capped' }, { as: 'product' }]],
  },
  cases: {
    C1: {
      title: 'Stock read back',
      needs: ['product'],
      block: [read('stock', { id: '{{product.id}}' })],
    },
    C2: {
      title: 'Stock after a cancel',
      needs: ['product'],
      after: ['C1'],
      block: [read('stock', { store: '{{env.storeId}}' })],
    },
    C3: { title: 'Judged by hand', block: [['stock', { purpose: 'verify' }]] },
  },
});

describe('promoting cases into a suite', () => {
  it('brings the cases a case runs after, its fixture, env values and logins', () => {
    const { suite, added } = promote(source, ['C2'], newSuite('store'));
    assert.deepEqual(added, [
      { from: 'C1', to: 'R1' },
      { from: 'C2', to: 'R2' },
    ]);
    assert.equal(suite.ticket, 'REG-STORE');
    assert.deepEqual(suite.cases.R2!.after, ['R1']);
    assert.deepEqual(suite.fixtures, { product: source.fixtures!.product });
    assert.deepEqual(suite.env, {
      local: { storeId: 'c-local' },
      staging: { storeId: 'c-staging' },
    });
    assert.deepEqual(suite.setup, [['login', { actor: 'seller' }]]);
    assert.doesNotThrow(() => parseCaseFile(suite), 'the suite is a case file of its own');
  });

  it('renames a fixture whose name is taken, with the name its data is saved under', () => {
    const suite = parseCaseFile({
      ...newSuite('store'),
      fixtures: { product: [['product_create', { name: 'other' }, { as: 'product' }]] },
      cases: {
        R1: {
          title: 'Older',
          needs: ['product'],
          block: [read('stock', { id: '{{product.id}}' })],
        },
      },
    });
    const { suite: out } = promote(source, ['C1'], suite);
    assert.deepEqual(out.fixtures!.product2, [
      ['product_create', { name: 'capped' }, { as: 'product2' }],
    ]);
    assert.deepEqual(out.cases.R2!.needs, ['product2']);
    assert.equal(out.cases.R2!.block[0]![1].id, '{{product2.id}}');
    assert.equal(out.cases.R1!.block[0]![1].id, '{{product.id}}', 'the older case is untouched');
  });

  it('renames clashing names in every fixture and case it copies, chained ones too', () => {
    const chained = parseCaseFile({
      ticket: 'AB-71',
      topic: 'AB-71 Chained',
      fixtures: {
        product: [['product_create', { name: 'capped' }, { as: 'product' }]],
        order: [['order_create', { product: '{{product.slug}}' }, { as: 'order' }]],
      },
      cases: {
        C1: {
          title: 'Order on the capped product',
          needs: ['product', 'order'],
          block: [
            ['product_create', { name: 'mine' }, { as: 'mine' }],
            read('stock', {
              id: '{{product.id}}',
              ref: '{{order.reference}}',
              own: '{{mine.id}}',
            }),
          ],
        },
      },
    });
    const suite = parseCaseFile({
      ...newSuite('store'),
      fixtures: {
        product: [['product_create', { name: 'other' }, { as: 'product' }]],
        order: [['order_create', { product: '{{product.slug}}' }, { as: 'order' }]],
      },
      cases: {
        R1: {
          title: 'Older',
          needs: ['product'],
          block: [
            ['product_create', { name: 'x' }, { as: 'mine' }],
            read('stock', { id: '{{product.id}}' }),
          ],
        },
      },
    });
    const { suite: out, fixtures } = promote(chained, ['C1'], suite);
    assert.deepEqual(fixtures, ['product2', 'order2']);
    assert.deepEqual(out.fixtures!.order2, [
      ['order_create', { product: '{{product2.slug}}' }, { as: 'order2' }],
    ]);
    const block = out.cases.R2!.block;
    assert.deepEqual(block[0], ['product_create', { name: 'mine' }, { as: 'mine2' }]);
    assert.deepEqual(block[1]![1], {
      purpose: 'verify',
      id: '{{product2.id}}',
      ref: '{{order2.reference}}',
      own: '{{mine2.id}}',
    });
    assert.deepEqual(out.fixtures!.order, suite.fixtures!.order, "the suite's own stay");
  });

  it('keeps a case the suite has when nothing new runs after it', () => {
    const first = promote(source, ['C1'], newSuite('store')).suite;
    const again = promote(source, ['C1'], first);
    assert.deepEqual(again.kept, [{ from: 'C1', to: 'R1' }]);
    assert.deepEqual(again.added, []);
  });

  it('brings fresh copies of the cases a new case runs after, kept or not', () => {
    const first = promote(source, ['C1'], newSuite('store')).suite;
    const again = promote(source, ['C2'], first);
    assert.deepEqual(again.kept, []);
    assert.deepEqual(again.added, [
      { from: 'C1', to: 'R2' },
      { from: 'C2', to: 'R3' },
    ]);
    assert.deepEqual(again.suite.cases.R3!.after, ['R2']);
    assert.deepEqual(again.suite.cases.R3!.needs, ['product2'], "its own product, not R1's");
    assert.deepEqual(again.suite.cases.R2!.needs, ['product2']);
  });

  it('keeps one variable per name across a copied chain, as in the ticket run', () => {
    const chain = parseCaseFile({
      ticket: 'AB-76',
      topic: 'AB-76 Chain',
      cases: {
        C1: { title: 'a', block: [['product_create', {}, { as: 'x' }], read('stock')] },
        C2: { title: 'b', block: [['product_create', {}, { as: 'x' }], read('stock')] },
        C3: { title: 'c', after: ['C1', 'C2'], block: [read('stock', { id: '{{x.id}}' })] },
      },
    });
    const first = promote(chain, ['C1'], newSuite('store')).suite;
    const { suite } = promote(chain, ['C3'], first);
    const saves = ['R2', 'R3'].map(r => suite.cases[r]!.block[0]![2]!.as);
    assert.deepEqual(saves, ['x2', 'x2']);
    assert.equal(suite.cases.R4!.block[0]![1].id, '{{x2.id}}', "reads C2's save, the latest");
    assert.equal(suite.cases.R1!.block[0]![2]!.as, 'x', 'the kept copy is untouched');
  });

  it('renames each name once, even when a new name matches another source name', () => {
    const named = parseCaseFile({
      ticket: 'AB-77',
      topic: 'AB-77 Names',
      cases: {
        C1: {
          title: 'a',
          block: [
            ['order_create', {}, { as: 'ord' }],
            ['order_create', {}, { as: 'ord2' }],
            read('stock', { a: '{{ord.reference}}', b: '{{ord2.reference}}' }),
          ],
        },
      },
    });
    const suite = parseCaseFile({
      ...newSuite('store'),
      cases: {
        R1: {
          title: 'x',
          block: [
            ['order_create', {}, { as: 'ord' }],
            ['order_create', {}, { as: 'ord2' }],
            read('stock'),
          ],
        },
      },
    });
    const block = promote(named, ['C1'], suite).suite.cases.R2!.block;
    assert.deepEqual([block[0]![2]!.as, block[1]![2]!.as], ['ord3', 'ord22']);
    assert.deepEqual(block[2]![1], {
      purpose: 'verify',
      a: '{{ord3.reference}}',
      b: '{{ord22.reference}}',
    });
  });

  it('refuses a case reading data from a case it does not run after', () => {
    const loose = parseCaseFile({
      ticket: 'AB-78',
      topic: 'AB-78 Loose',
      cases: {
        C1: { title: 'a', block: [['product_create', {}, { as: 'product' }], read('stock')] },
        C2: { title: 'b', block: [read('stock', { id: '{{product.id}}', c: '{{env.store}}' })] },
      },
    });
    assert.throws(
      () => promote(loose, ['C2'], newSuite('store')),
      /C2 reads product before it or a case it runs after saves it/,
    );
    assert.throws(
      () => promote(loose, ['C1', 'C2'], newSuite('store')),
      /C2 reads product/,
      'promoted together, they could still run apart',
    );
    const early = parseCaseFile({
      ticket: 'AB-79',
      topic: 'AB-79 Early read',
      cases: {
        C1: { title: 'a', block: [['order_create', {}, { as: 'order' }], read('stock')] },
        C2: {
          title: 'b',
          block: [
            ['order_cancel', { ref: '{{order.reference}}' }],
            ['order_create', {}, { as: 'order' }],
            read('stock', { ref: '{{order.reference}}' }),
          ],
        },
      },
    });
    assert.throws(
      () => promote(early, ['C2'], newSuite('store')),
      /C2 reads order before/,
      'its own save comes after the read',
    );
  });

  it("refuses run-wide placeholders, which would read other cases' data in a suite", () => {
    const positional = parseCaseFile({
      ticket: 'AB-72',
      topic: 'AB-72 Positional',
      cases: { C1: { title: 'x', block: [read('stock', { id: '{{SKU1}}', slug: '{{PAGE}}' })] } },
    });
    assert.throws(
      () => promote(positional, ['C1'], newSuite('store')),
      /\{\{SKU1\}\}, \{\{PAGE\}\}/,
    );
  });

  it('refuses a case someone would have to judge, an unknown case and a clashing env value', () => {
    assert.throws(
      () => promote(source, ['C3'], newSuite('store')),
      /C3 would need someone to judge/,
    );
    assert.throws(() => promote(source, ['C9'], newSuite('store')), /Not cases of AB-70: C9/);
    const other = parseCaseFile({
      ...newSuite('store'),
      env: { local: { storeId: 'different' } },
    });
    assert.throws(() => promote(source, ['C2'], other), /other values for local.storeId/);
  });
});
