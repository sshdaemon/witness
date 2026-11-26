import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { realDate } from '../src/mcp/schemas.js';

describe('realDate', () => {
  for (const [value, valid] of [
    ['2026-02-28', true],
    ['2028-02-29', true],
    ['2026-12-31', true],
    ['2026-13-45', false],
    ['2026-02-30', false],
    ['2026-00-10', false],
    ['2026-1-1', false],
    ['tomorrow', false],
  ] as [string, boolean][]) {
    it(`${value} is ${valid ? 'accepted' : 'rejected'} without throwing`, () =>
      assert.equal(realDate.safeParse(value).success, valid));
  }
});
