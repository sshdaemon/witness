import { topicTitle } from '../titles.js';
import { failedSteps, reportRuns, type ReportRun } from '../read/index.js';
import type { Builds } from '../app.js';
import { prose } from '../prose.js';

type RunRow = ReportRun;

const buildLabel = (b?: Builds[keyof Builds]) =>
  b ? `${b.branch ?? 'detached'}@${b.sha}${b.dirty ? ' (+local changes)' : ''}` : undefined;
const when = (iso: string) => `${iso.replace('T', ' ').slice(0, 16)} UTC`;
const seconds = (r: RunRow) =>
  r.finished_at
    ? `${Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000)} s`
    : 'unfinished';

function builds(r: RunRow): Builds {
  try {
    return r.app_versions ? (JSON.parse(r.app_versions) as Builds) : {};
  } catch {
    return {};
  }
}

// "ok: a; FAIL: b | note" is how sessions write checks in run_finish; free text stays as it is.
const bullets = (summary: string | null) =>
  (summary ?? '')
    .split(/;\s+|\s+\|\s+/)
    .filter(Boolean)
    .map(line => `- ${line.replace(/^ok:\s*/, '✓ ').replace(/^FAIL:\s*/, '✕ ')}`)
    .join('\n');

function runSection(r: RunRow, heading: string): string {
  const out = [`${heading} ${r.verdict ?? 'UNFINISHED'} — ${when(r.started_at)}`, ''];
  const stack = Object.entries(builds(r)).map(([app, b]) => `${app} ${buildLabel(b)}`);
  out.push(
    prose`
      Environment: ${r.env}${r.branch ? ` · testing branch ${r.branch}` : ''} · ${seconds(r)} ·
      run \`${r.id}\``,
  );
  if (stack.length > 0) out.push(`Served from: ${stack.join('; ')}`);
  if (r.summary) out.push('', bullets(r.summary));
  const failed = failedSteps(r.id);
  if (failed.length > 0) {
    out.push('', 'Failed steps:');
    for (const f of failed)
      out.push(`- step ${f.seq} \`${f.tool}\` ${f.errorCode ?? ''} ${f.message}`.trimEnd());
  }
  return out.join('\n');
}

/**
 * Raw notes for drafting a ticket or pull request comment: one run, or the latest runs of a
 * topic. Local evidence paths are left out on purpose.
 */
export function buildReport(opts: {
  runId?: string;
  topic?: string;
  last?: number;
}): string | undefined {
  const rows = reportRuns(opts);
  if (opts.runId) {
    const r = rows[0];
    return r && `# UI test: ${topicTitle(r.topic)}\n\n${runSection(r, '##')}\n`;
  }
  if (rows.length === 0) return undefined;
  return [
    `# UI test: ${topicTitle(rows[0]!.topic)}`,
    '',
    ...rows.map((r, i) => `${runSection(r, i === 0 ? '## Latest:' : '## Earlier:')}\n`),
  ].join('\n');
}
