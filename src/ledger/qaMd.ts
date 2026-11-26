import { app } from '../app.js';
import { caseHash, pseudoCalls, type CaseFile } from '../runner/caseFile.js';

/** A case's result in one run, as the store keeps it. */
export type LedgerResult = {
  run_id: string;
  case_id: string;
  run_number: number | null;
  env: string | null;
  result: string;
  actual: string | null;
  note: string | null;
  case_hash: string | null;
  finished_at: string;
};

/** A run of the ticket; one removed by retention is known only from its case results. */
export type LedgerRun = {
  id: string;
  run_number: number | null;
  env: string | null;
  started_at: string | null;
  verdict: string | null;
  /** The lane of a batch run in parallel lanes. */
  lane?: number | null;
};

const WORD: Record<string, string> = { NOT_RUN: 'NOT RUN' };
const byCaseId = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/** Text safe inside a table cell or a list line: one line, no column breaks. */
const cell = (s: string) => s.replaceAll(/\s+/g, ' ').replaceAll('|', '\\|').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The Cases section: the table (id, use case, actor, kind, the tools it uses, its latest result in
 * each environment) and each case's steps and expected result, from the case file and the store.
 */
export function renderCases(file: CaseFile, results: LedgerResult[]): string {
  // Cases run by hand have results but no definition: they get a row, and their text is by hand.
  const ids = [...new Set([...Object.keys(file.cases), ...results.map(r => r.case_id)])].toSorted(
    byCaseId,
  );
  // Results from before they kept their environment form a group of their own.
  const latest = (id: string, env: string | null) =>
    results
      .filter(r => r.case_id === id && r.env === env)
      .toSorted((a, b) => a.finished_at.localeCompare(b.finished_at))
      .at(-1);
  const order: readonly string[] = app().envs;
  const rank = (e: string | null) => (e === null ? 98 : order.indexOf(e) + 1 || 99);
  const envs = [...new Set(results.map(r => r.env))].toSorted((a, b) => rank(a) - rank(b));
  const resultOf = (id: string) => {
    const def = file.cases[id];
    const hash = def ? caseHash(def, file.fixtures) : null;
    const parts = envs.flatMap(env => {
      const r = latest(id, env);
      if (!r) return [];
      const older = hash && r.case_hash && r.case_hash !== hash ? ', earlier version' : '';
      const where = env ? `${env} run` : 'run';
      return [`${WORD[r.result] ?? r.result} (${where} ${r.run_number ?? '?'}${older})`];
    });
    return parts.length > 0 ? parts.join('; ') : 'not run';
  };
  const pseudo = pseudoCalls();
  const tools = (id: string) => {
    const c = file.cases[id];
    if (!c) return '';
    const names = [...(c.needs ?? []).flatMap(f => file.fixtures?.[f] ?? []), ...c.block]
      .map(call => call[0])
      .filter(n => !pseudo.has(n));
    return [...new Set(names)].map(n => `\`${n}\``).join(', ');
  };
  const rows = ids.map(id => {
    const c = file.cases[id] ?? { title: '(not in the case file)', block: [] };
    const cells = [
      id,
      cell(c.title),
      cell(c.actor ?? ''),
      cell(c.kind ?? ''),
      tools(id),
      resultOf(id),
    ];
    return `| ${cells.join(' | ')} |`;
  });
  const details = ids
    .filter(id => file.cases[id])
    .map(id => {
      const c = file.cases[id]!;
      const lines = [`### ${id}. ${c.title}`, ''];
      if (c.steps?.length) lines.push('**Steps**', ...c.steps.map((s, i) => `${i + 1}. ${s}`), '');
      if (c.expected) lines.push('**Expected result**', c.expected, '');
      const setup = [
        c.needs?.length ? `Needs ${c.needs.join(', ')}.` : '',
        c.after?.length ? `Runs after ${c.after.join(', ')}.` : '',
      ].filter(Boolean);
      if (setup.length > 0) lines.push(setup.join(' '), '');
      return lines.join('\n').trimEnd();
    });
  return [
    '| id | use case | actor | kind | how | result |',
    '| -- | -- | -- | -- | -- | -- |',
    ...rows,
    '',
    ...details.flatMap(d => [d, '']),
  ]
    .join('\n')
    .trimEnd();
}

const RUN_LINE = /^- Run (\d+)(?: lane (\d+))? \(.*?(\d{14}-[0-9a-z]+)\):/;

/**
 * The Runs section: one line per numbered run, oldest first, with each case's result. A run the
 * store no longer has (removed by retention) keeps the line an earlier pass wrote for it.
 */
export function renderRuns(runs: LedgerRun[], results: LedgerResult[], previous = ''): string {
  type Line = { n: number; lane: number; line: string };
  const written = new Map<string, Line>();
  for (const line of previous.split('\n')) {
    const m = RUN_LINE.exec(line);
    if (m) written.set(m[3]!, { n: Number(m[1]), lane: Number(m[2] ?? 0), line });
  }
  const all = new Map<string, LedgerRun & { removed: boolean }>(
    runs.map(r => [r.id, { ...r, removed: false }]),
  );
  for (const r of results)
    if (!all.has(r.run_id))
      all.set(r.run_id, {
        id: r.run_id,
        run_number: r.run_number,
        env: r.env,
        started_at: null,
        verdict: null,
        removed: true,
      });
  const lines = new Map<string, Line>();
  for (const run of all.values()) {
    if (run.run_number == null) continue;
    const kept = run.removed ? written.get(run.id) : undefined;
    lines.set(
      run.id,
      kept ?? { n: run.run_number, lane: run.lane ?? 0, line: runLine(run, results) },
    );
  }
  for (const [id, w] of written) if (!lines.has(id)) lines.set(id, w);
  const ordered = [...lines.entries()].toSorted(
    (a, b) => a[1].n - b[1].n || a[1].lane - b[1].lane || a[0].localeCompare(b[0]),
  );
  if (ordered.length === 0) return '_No runs recorded yet._';
  return ordered.map(([, w]) => w.line).join('\n');
}

function runLine(run: LedgerRun & { removed: boolean }, results: LedgerResult[]): string {
  const mine = results
    .filter(r => r.run_id === run.id)
    .toSorted((a, b) => byCaseId(a.case_id, b.case_id));
  // A removed run's start is gone; its first case result is close enough for a date.
  const when = (run.started_at ?? mine.map(r => r.finished_at).toSorted()[0] ?? '').slice(0, 10);
  const where = [run.env, when, run.id].filter(Boolean).join(', ');
  const lane = run.lane ? ` lane ${run.lane}` : '';
  const head = `- Run ${run.run_number}${lane} (${where}): ${
    run.removed ? 'removed by retention' : (run.verdict ?? 'still open')
  }.`;
  const cases = mine
    .map(r => {
      const why = r.actual ?? r.note;
      const reason = why ? ` (${cell(clip(why, 90))})` : '';
      return `${r.case_id} ${WORD[r.result] ?? r.result}${reason}`;
    })
    .join('; ');
  return cases ? `${head} ${cases}.` : `${head} No cases recorded.`;
}

/** What sits between a section's markers now, or '' when it has none. */
export function readSection(text: string, name: string): string {
  const start = `<!-- ${name}:start -->`;
  const i = text.indexOf(start);
  const j = text.indexOf(`<!-- ${name}:end -->`);
  return i !== -1 && j > i ? text.slice(i + start.length, j) : '';
}

/**
 * Replaces what sits between `<!-- name:start -->` and `<!-- name:end -->`, leaving the rest of
 * the ledger as it is.
 */
export function replaceSection(text: string, name: string, body: string): string {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  if (i === -1 || j === -1 || j < i)
    throw new Error(
      `The ledger has no ${start} … ${end} section: add both markers where the generated ` +
        `${name} go.`,
    );
  return `${text.slice(0, i + start.length)}\n${body}\n${text.slice(j)}`;
}
