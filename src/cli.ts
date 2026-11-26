// The runner's commands. An app's own script sets its app (setApp) and hands its argv here, the
// way its worker script calls runWorker.
import { promote } from './cli/promote.js';
import { qaMd } from './cli/qaMd.js';
import { runSteps, type StepsOptions } from './cli/steps.js';

export type CliOptions = StepsOptions;

export function runCli(argv: string[], opts: CliOptions): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'steps':
      return runSteps(rest, opts);
    case 'qa-md':
      qaMd(rest);
      return Promise.resolve();
    case 'promote':
      promote(rest);
      return Promise.resolve();
    default:
      console.error('usage: <cli> steps|qa-md|promote [args]');
      process.exit(2);
  }
}
