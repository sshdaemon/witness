import { app as appDef, type EnvName } from '../app.js';
import { caseHash, type CaseFile } from './caseFile.js';
import type { Caller } from './execute.js';

/** Which commit served each app, with "+" for local changes, from a run's recorded builds. */
export function buildMap(appVersions: unknown): Map<string, string> {
  if (!appVersions || typeof appVersions !== 'object') return new Map();
  return new Map(
    Object.entries(appVersions as Record<string, { sha?: string; dirty?: boolean } | null>)
      .filter(([, b]) => b?.sha)
      .map(([app, b]) => [app, `${b!.sha}${b!.dirty ? '+' : ''}`]),
  );
}

/**
 * Whether an app both builds have was served from another commit (or with local changes). Apps
 * only one of them had running say nothing about the code under test.
 */
export const otherBuild = (a: Map<string, string>, b: Map<string, string>) =>
  [...a].some(([app, sha]) => b.has(app) && b.get(app) !== sha);

type TicketCase = {
  caseId: string;
  latest: { result: string; caseHash: string | null; appVersions: unknown } | null;
};

/**
 * The cases of a case file still to run: never run, not passed last time, changed since, or passed
 * on other builds than the stack serves now. Where the app knows no builds (staging), only the
 * results and versions count.
 */
export async function missingCases(file: CaseFile, call: Caller, env?: string): Promise<string[]> {
  const where = env ?? appDef().defaultEnv();
  // Only a result from this environment says anything about the build about to be tested.
  const known = await call('ticket_cases', { ticket: file.ticket, env: where });
  if (known.isError) throw new Error(`ticket_cases: ${known.out.code} ${known.out.message}`);
  const cases = (known.out.data?.cases ?? []) as TicketCase[];
  const now = buildMap(await appDef().runner?.currentBuilds?.(where as EnvName, call));
  return Object.entries(file.cases)
    .filter(([id, def]) => {
      const latest = cases.find(c => c.caseId === id)?.latest;
      return (
        !latest ||
        latest.result !== 'PASS' ||
        latest.caseHash !== caseHash(def, file.fixtures) ||
        otherBuild(buildMap(latest.appVersions), now)
      );
    })
    .map(([id]) => id);
}
