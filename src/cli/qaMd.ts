// Rewrites the generated Cases and Runs sections of a ticket's QA ledger from its case file and
// the results store. Only the text between the section markers changes.
// Usage: npm run qa-md -- <…/<name>-cases.json> [--ledger <path to <name>.qa.md>]
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { readSection, renderCases, renderRuns, replaceSection } from '../ledger/qaMd.js';
import { parseCaseFile } from '../runner/caseFile.js';
import { ledgerRows } from '../read/index.js';

const usage = () => {
  console.error('usage: npm run qa-md -- <…/<name>-cases.json> [--ledger <path>]');
  process.exit(2);
};

/** `qa-md <case file> [--ledger <path>]`: the app is set (setApp) before this runs. */
export function qaMd(argv: string[]): void {
  const [file, ...flags] = argv;
  if (!file || file.startsWith('--')) usage();
  let ledgerFlag: string | undefined;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--ledger' && flags[i + 1] && !flags[i + 1]!.startsWith('--'))
      ledgerFlag = flags[++i];
    else usage();
  }
  if (!ledgerFlag && !file!.endsWith('-cases.json')) {
    console.error('A case file is named <name>-cases.json; pass --ledger for another name.');
    process.exit(2);
  }
  const ledger = ledgerFlag
    ? resolve(ledgerFlag)
    : resolve(dirname(file!), `${basename(file!).replace(/-cases\.json$/, '')}.qa.md`);
  if (!existsSync(ledger) || !statSync(ledger).isFile()) {
    console.error(`No ledger at ${ledger}: create it from the qa-loop template, or pass --ledger.`);
    process.exit(2);
  }

  let caseFile;
  try {
    caseFile = parseCaseFile(JSON.parse(readFileSync(file!, 'utf8')));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }

  // Read only: the ledger never changes the store.
  const { results, runs } = ledgerRows(caseFile.ticket);

  const before = readFileSync(ledger, 'utf8');
  let after: string;
  try {
    after = replaceSection(before, 'cases', renderCases(caseFile, results));
    after = replaceSection(after, 'runs', renderRuns(runs, results, readSection(before, 'runs')));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  if (after === before) console.log(`${ledger}: already up to date.`);
  else {
    writeFileSync(ledger, after);
    console.log(
      `${ledger}: ${Object.keys(caseFile.cases).length} cases, ${
        new Set([...runs.map(r => r.id), ...results.map(r => r.run_id)]).size
      } runs.`,
    );
  }
}
