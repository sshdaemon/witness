import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runLabel, runName } from '../src/mcp/names.js';

test('runName reads tag, label, words', () => {
  assert.equal(
    runName('k3m9qa', 'AB-1234 run 3', 'buyer phone'),
    'k3m9qa AB-1234 run 3 buyer phone',
  );
  assert.equal(runName('k3m9qa', undefined, 'ticket'), 'k3m9qa ticket');
  assert.equal(runName('k3m9qa', 'AB-1234 run 3', ''), 'k3m9qa AB-1234 run 3');
});

test('runName drops whole words from the end, then the label, to fit', () => {
  assert.equal(
    runName('k3m9qa', 'AB-1234 run 3', 'a very long product name here', 30),
    'k3m9qa AB-1234 run 3 a very',
  );
  assert.equal(runName('k3m9qa', 'AB-1234 run 3', 'ticket', 24), 'k3m9qa AB-1234 run 3');
  assert.equal(runName('k3m9qa', 'AB-1234 run 3', 'ticket', 15), 'k3m9qa ticket');
  assert.equal(runName('k3m9qa', 'AB-1234 run 3', 'ticket', 6), 'k3m9qa');
});

test('runName with keepWords drops the label before the words', () => {
  assert.equal(runName('k3m9qa', 'AB-1234 run 3', 'free', 24, { keepWords: true }), 'k3m9qa free');
  assert.equal(runName('k3m9qa', 'AB-1234 run 3', 'paid', 24, { keepWords: true }), 'k3m9qa paid');
  assert.equal(runName('k3m9qa', 'AB', 'free', 24, { keepWords: true }), 'k3m9qa AB free');
  assert.equal(
    runName('k3m9qa', 'AB-1234 run 3', 'gift card discount', 24, { keepWords: true }),
    'k3m9qa gift card',
  );
  assert.equal(
    runName('k3m9qa', 'AB-1234 run 3', 'free sample sachet', 24, { keepWords: true }),
    'k3m9qa free sample',
  );
  assert.equal(
    runName('k3m9qa', 'AB-1234 run 3', 'paid item purchase', 24, { keepWords: true }),
    'k3m9qa paid item',
  );
});

test('runName does not repeat a prefix the words already carry', () => {
  assert.equal(
    runName('k3m9qa', 'AB-1234 run 3', 'k3m9qa AB-1234 run 3 buyer phone'),
    'k3m9qa AB-1234 run 3 buyer phone',
  );
  assert.equal(
    runName('k3m9qa', 'AB-1234 run 3', 'AB-1234 run 3 buyer phone'),
    'k3m9qa AB-1234 run 3 buyer phone',
  );
  assert.equal(
    runName('k3m9qa', 'AB-1234 run 3', 'k3m9qa buyer phone'),
    'k3m9qa AB-1234 run 3 buyer phone',
  );
});

test('runLabel accepts tickets and PRs and refuses characters names may not hold', () => {
  assert.ok(runLabel.safeParse('AB-1234 run 3').success);
  assert.ok(runLabel.safeParse('PR 42 run 1').success);
  assert.ok(!runLabel.safeParse('web#42').success);
  assert.ok(!runLabel.safeParse('x').success);
  assert.ok(!runLabel.safeParse('a much too long label for a name x').success);
  assert.equal(runLabel.parse(' AB-12  run 3 '), 'AB-12 run 3');
});
