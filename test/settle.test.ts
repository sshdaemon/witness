import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { untilStable } from '../src/browser/settle.js';

const page = { waitForTimeout: async () => {} };
const reads = <T>(values: T[]) => {
  let i = 0;
  const read = async () => values[Math.min(i++, values.length - 1)]!;
  return { read, count: () => i };
};

describe('untilStable', () => {
  it('settles once the same value is read times + 1 times in a row', async () => {
    const r = reads(['a', 'b', 'b', 'b']);
    assert.deepEqual(await untilStable(page, r.read, { times: 2, every: 1, tries: 10 }), {
      value: 'b',
      settled: true,
    });
    assert.equal(r.count(), 4);
  });

  it('counts only reads that are ready', async () => {
    const r = reads([0, 0, 0, 0, 2, 2, 2, 2]);
    const out = await untilStable(page, r.read, {
      times: 3,
      every: 1,
      tries: 20,
      ready: n => n > 0,
    });
    assert.deepEqual(out, { value: 2, settled: true });
    assert.equal(r.count(), 8);
  });

  it('compares structured reads by value', async () => {
    const r = reads([{ rows: 1 }, { rows: 2 }, { rows: 2 }]);
    assert.deepEqual(await untilStable(page, r.read, { times: 1, every: 1, tries: 5 }), {
      value: { rows: 2 },
      settled: true,
    });
  });

  it('gives the last read and settled false when it runs out of tries', async () => {
    const r = reads([1, 2, 3, 4, 5]);
    assert.deepEqual(await untilStable(page, r.read, { times: 2, every: 1, tries: 5 }), {
      value: 5,
      settled: false,
    });
  });
});

describe('untilStable with a time limit', () => {
  it('stops at the deadline even with tries left', async () => {
    let n = 0;
    const slow = {
      waitForTimeout: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    };
    const started = Date.now();
    const out = await untilStable(slow, async () => n++, {
      times: 2,
      every: 20,
      tries: Infinity,
      withinMs: 100,
    });
    assert.equal(out.settled, false);
    assert.ok(Date.now() - started < 400);
  });
});
