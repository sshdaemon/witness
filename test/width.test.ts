import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import type * as TypeScript from 'typescript';

const WIDTH = 100;
const ROOT = resolve(import.meta.dirname, '..');
// What cannot be wrapped: a single import, and a lint directive that must stay right above its
// code.
const UNBREAKABLE = /^\s*import .* from '[^']+';$|oxlint-disable|eslint-disable/;

const sources = (dir: string): string[] =>
  readdirSync(resolve(ROOT, dir), { withFileTypes: true }).flatMap(d => {
    if (d.isDirectory()) return sources(`${dir}/${d.name}`);
    if (d.name.endsWith('.ts')) return [`${dir}/${d.name}`];
    return [];
  });

describe('line width', () => {
  it(`keeps TypeScript lines within ${WIDTH} columns (long text goes in prose\`...\`)`, () => {
    const long = ['src', 'test'].flatMap(sources).flatMap(file =>
      readFileSync(resolve(ROOT, file), 'utf8')
        .split('\n')
        .map((line, i) => ({ line, at: `${file}:${i + 1}` }))
        .filter(({ line }) => line.length > WIDTH && !UNBREAKABLE.test(line))
        .map(({ at, line }) => `${at} (${line.length})`),
    );
    assert.deepEqual(long, []);
  });

  it('uses no prose`...` in code that runs in the browser, where prose does not exist', () => {
    const ts = createRequire(import.meta.url)('typescript') as typeof TypeScript;
    const BROWSER = new Set([
      'evaluate',
      'evaluateAll',
      'evaluateHandle',
      'waitForFunction',
      'addInitScript',
      '$eval',
      '$$eval',
    ]);
    const found: string[] = [];
    for (const file of sources('src')) {
      const sf = ts.createSourceFile(file, readFileSync(resolve(ROOT, file), 'utf8'), 99, true);
      const visit = (node: TypeScript.Node, inBrowser: boolean): void => {
        const called =
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          BROWSER.has(node.expression.name.text);
        if (inBrowser && ts.isTaggedTemplateExpression(node) && node.tag.getText() === 'prose')
          found.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        ts.forEachChild(node, child =>
          visit(
            child,
            inBrowser || (called && child !== (node as TypeScript.CallExpression).expression),
          ),
        );
      };
      visit(sf, false);
    }
    assert.deepEqual(found, []);
  });
});
