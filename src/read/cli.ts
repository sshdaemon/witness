// Prints what the results store holds as JSON, read-only, for readers outside the engine (a QA
// checker, a script). The commands and fields are the read contract: docs/read-contract.md.
import { DB_PATH, RESULTS_DIR } from '../paths.js';
import {
  caseDetail,
  closeReader,
  evidence,
  ledgerRows,
  runDetail,
  runs,
  ticketDetail,
  tickets,
} from './index.js';

const USAGE = `usage: npm run -s read -- <command>
  where                           the store folder and database
  runs [--topic t] [--env e] [--verdict v] [--limit n]
  run <runId>                     the run, its cases, artifacts and lanes (no steps)
  steps <runId> [--from n] [--to m]   steps with their answers and screenshot paths
  tickets                         every ticket with its cases' latest results
  ticket <ticket>                 one ticket's cases and runs
  case <ticket> <caseId>          one case's results, screenshots and picked evidence
  ledger <ticket>                 the rows a ticket's QA ledger is built from
  evidence                        picked screenshots by ticket`;

const [command, ...rest] = process.argv.slice(2);
const positional = rest.filter((a, i) => !a.startsWith('--') && !rest[i - 1]?.startsWith('--'));
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
};
const number = (name: string) => {
  const v = flag(name);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) fail(`--${name} must be a whole number, not ${v}`);
  return Number(v);
};

function fail(message: string): never {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}

/** The first positional argument, required. */
const arg = (i: number, what: string) => positional[i] ?? fail(`missing ${what}`);

function read(): unknown {
  switch (command) {
    case 'where':
      return { resultsDir: RESULTS_DIR, database: DB_PATH };
    case 'runs':
      return runs({
        topic: flag('topic'),
        env: flag('env'),
        verdict: flag('verdict'),
        limit: number('limit'),
      });
    case 'run': {
      const detail = runDetail(arg(0, 'runId'), { steps: { from: 1, to: 0 } });
      if (!detail) return undefined;
      const { steps: _none, ...withoutSteps } = detail;
      return withoutSteps;
    }
    case 'steps': {
      const from = number('from') ?? 0;
      const to = number('to') ?? Number.MAX_SAFE_INTEGER;
      return runDetail(arg(0, 'runId'), { steps: { from, to } })?.steps;
    }
    case 'tickets':
      return tickets();
    case 'ticket':
      return ticketDetail(arg(0, 'ticket'));
    case 'case':
      return caseDetail(arg(0, 'ticket'), arg(1, 'caseId'));
    case 'ledger':
      return ledgerRows(arg(0, 'ticket'));
    case 'evidence':
      return evidence();
    default:
      return fail(command ? `unknown command ${command}` : 'no command');
  }
}

const out = read();
closeReader();
if (out === undefined) {
  console.error('not found');
  process.exit(1);
}
console.log(JSON.stringify(out, null, 2));
