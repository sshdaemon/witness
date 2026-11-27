import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseStepsArgs, UsageError } from '../src/cli/steps.js';

await import('./helpers/app.js');

const envs = ['local', 'staging'];
const caseFile = JSON.stringify({
  ticket: 'AB-80',
  cases: { C1: { title: 'One', block: [['stock', { purpose: 'verify' }]] } },
});
const calls = JSON.stringify([
  ['stock', {}],
  ['sleep', { seconds: 1 }],
]);
const files: Record<string, string> = { 'cases.json': caseFile, 'calls.json': calls };
const parse = (...argv: string[]) => parseStepsArgs(argv, envs, path => files[path]!);
const refuses = (pattern: RegExp, ...argv: string[]) =>
  assert.throws(
    () => parse(...argv),
    (e: unknown) => e instanceof UsageError && pattern.test(e.message),
  );

describe('the steps command line', () => {
  it('reads a plain list of calls', () => {
    const args = parse('calls.json');
    assert.equal(args.caseFile, undefined);
    assert.deepEqual(
      args.steps.map(s => s[0]),
      ['stock', 'sleep'],
    );
  });

  it('reads a case file and its flags', () => {
    const args = parse('cases.json', '--env', 'staging', '--missing', '--lanes', '2');
    assert.equal(args.caseFile?.ticket, 'AB-80');
    assert.deepEqual(args.steps, []);
    assert.equal(args.flag('--env'), 'staging');
    assert.equal(args.flag('--lanes'), '2');
    assert.equal(args.flag('--cases'), undefined);
    assert.equal(args.has('--missing'), true);
  });

  it('gives an empty value to a flag at the end', () => {
    assert.equal(parse('calls.json', '--branch').flag('--branch'), '');
  });

  it('refuses a missing file, an unknown environment and unknown cases', () => {
    refuses(/^usage: .*--env local\|staging/);
    refuses(/--env is one of local, staging/, 'cases.json', '--env', 'prod');
    refuses(/Not cases of AB-80: C9/, 'cases.json', '--cases', 'C1,C9');
  });

  it('refuses a case file that does not parse', () => {
    files['bad.json'] = JSON.stringify({ ticket: 'AB-81' });
    assert.throws(() => parse('bad.json'), UsageError);
  });
});
