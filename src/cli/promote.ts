// Copies cases of a ticket's case file into a regression suite in suites/<area>.json, where they
// can be run again later with nobody to judge them.
// Usage: npm run promote -- <…/<name>-cases.json> <C1,C2> --suite <area>
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { app } from '../app.js';
import { parseCaseFile, type CaseFile } from '../runner/caseFile.js';
import { newSuite, promote as promoteCases } from '../runner/promote.js';

const usage = () => {
  console.error('usage: npm run promote -- <case file> <C1,C2> --suite <area>');
  process.exit(2);
};

const read = (path: string): CaseFile => parseCaseFile(JSON.parse(readFileSync(path, 'utf8')));

/** `promote <case file> <C1,C2> --suite <area>`, into the suites folder of the app's checkout. */
export function promote(argv: string[]): void {
  const [file, list, flag, area, ...rest] = argv;
  if (!file || !list || flag !== '--suite' || !area || rest.length > 0) usage();
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(area!)) {
    console.error('An area is lowercase letters, digits and hyphens, for example "checkout".');
    process.exit(2);
  }

  const target = resolve(app().root, 'suites', `${area}.json`);
  let result;
  try {
    const source = read(file!);
    const suite = existsSync(target) ? read(target) : newSuite(area!);
    result = promoteCases(source, list!.split(',').filter(Boolean), suite);
    // A suite that would not read back is not written.
    parseCaseFile(result.suite);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }

  // The suite outlives the ticket, so its text should not lean on ticket ids.
  const copied = [
    ...result.added.map(a => [a.to, result.suite.cases[a.to]] as const),
    ...result.fixtures.map(f => [`fixture ${f}`, result.suite.fixtures?.[f]] as const),
  ];
  for (const [where, value] of copied) {
    const ids = [...new Set(JSON.stringify(value).match(/\b[A-Z][A-Z0-9]*-\d{2,}\b/g) ?? [])];
    if (ids.length > 0)
      console.log(`Note: ${where} mentions ${ids.join(', ')}; say it in words before committing.`);
  }

  mkdirSync(resolve(app().root, 'suites'), { recursive: true });
  writeFileSync(target, `${JSON.stringify(result.suite, null, 2)}\n`);
  // The app's own formatter, when it has oxfmt, so its format check stays clean.
  const oxfmt = resolve(app().root, 'node_modules/.bin/oxfmt');
  if (existsSync(oxfmt)) execFileSync(oxfmt, [target], { stdio: 'ignore' });
  for (const { from, to } of result.added) console.log(`${from} → ${to}`);
  for (const { from, to } of result.kept) console.log(`${from} is already in the suite as ${to}`);
  console.log(`${target}: ${Object.keys(result.suite.cases).length} cases.`);
}
