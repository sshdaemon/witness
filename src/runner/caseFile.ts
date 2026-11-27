import { createHash } from 'node:crypto';
import { z } from 'zod';
import { app } from '../app.js';
import { CASE } from '../mcp/evidence.js';

/** A check on one call's answer: where to look in its data, and what must hold there. */
const dataExpect = z
  .object({
    path: z.string().min(1),
    equals: z.unknown().optional(),
    contains: z.unknown().optional(),
    excludes: z.unknown().optional(),
    matches: z.string().optional(),
    count: z.number().int().min(0).optional(),
    exists: z.boolean().optional(),
  })
  .strict()
  .refine(
    e =>
      ['equals', 'contains', 'excludes', 'matches', 'count', 'exists'].filter(k => k in e)
        .length === 1,
    'an expect has a path and exactly one of equals, contains, excludes, matches, count, exists',
  );

/** The call must fail with this code (and a message containing this text). */
const errorExpect = z.object({ error: z.string().min(1), message: z.string().optional() }).strict();

const options = z
  .object({
    mayFail: z.boolean().optional(),
    as: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
      .optional(),
    expect: z.union([z.array(dataExpect).min(1), errorExpect]).optional(),
  })
  .strict();

export const callSchema = z.union([
  z.tuple([z.string().min(1), z.record(z.string(), z.unknown())]),
  z.tuple([z.string().min(1), z.record(z.string(), z.unknown()), options]),
]);

// The same limits as cases_define and case_begin, so a file that parses can be recorded whole.
const caseId = z.string().regex(CASE, 'case ids are letters, digits, ., _ and -, up to 21 long');
const caseSchema = z
  .object({
    title: z.string().min(1).max(200),
    /** Who acts, by role (the app's actors), and the kind of case. */
    actor: z.string().max(60).optional(),
    kind: z.enum(['happy', 'edge', 'regression']).optional(),
    /** In a regression suite: the version of the ticket's case it was promoted from. */
    origin: z.string().max(40).optional(),
    steps: z.array(z.string().max(500)).max(30).optional(),
    expected: z.string().max(2000).optional(),
    needs: z.array(z.string().max(60)).max(20).optional(),
    after: z.array(caseId).max(20).optional(),
    uses: z.array(z.string()).optional(),
    block: z.array(callSchema).min(1).max(200),
  })
  .strict()
  .refine(
    c =>
      c.block.reduce(
        (n, call) => n + (Array.isArray(call[2]?.expect) ? call[2].expect.length : 1),
        0,
      ) <= 200,
    'at most 200 expects in a case',
  );

export const caseFileSchema = z
  .object({
    ticket: z.string().min(2),
    /** The ticket's title, shown by the viewer. */
    title: z.string().min(3).max(200).optional(),
    branch: z.string().max(120).optional(),
    env: z.record(z.string(), z.record(z.string(), z.string())).optional(),
    /** The logins every run (each lane its own browser) makes first. */
    setup: z
      .array(callSchema)
      .max(20)
      .refine(
        calls => calls.every(c => c[0] === 'login' && !c[2]?.as),
        'setup holds plain login calls only, with nothing saved by "as"',
      )
      .optional(),
    fixtures: z.record(z.string(), z.array(callSchema).min(1)).optional(),
    cases: z
      .record(caseId, caseSchema)
      .refine(c => Object.keys(c).length <= 200, 'at most 200 cases'),
  })
  .strict();

export type Call = z.infer<typeof callSchema>;
export type DataExpect = z.infer<typeof dataExpect>;
export type ErrorExpect = z.infer<typeof errorExpect>;
export type CaseDef = z.infer<typeof caseSchema>;
export type CaseFile = z.infer<typeof caseFileSchema>;

/** Calls the runner handles itself instead of sending them to the server. */
export const pseudoCalls = () => new Set(['sleep', ...Object.keys(app().runner?.waits ?? {})]);

/**
 * Reads a case file and checks it holds together: every fixture a case needs and every case it
 * runs after exists, and no case runs after itself.
 */
export function parseCaseFile(raw: unknown): CaseFile {
  const parsed = caseFileSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `Not a valid case file: ${parsed.error.issues
        .slice(0, 5)
        .map(i => `${i.path.join('.') || '(top)'}: ${i.message}`)
        .join('; ')}`,
    );
  const file = parsed.data;
  const problems: string[] = [];
  for (const [id, c] of Object.entries(file.cases)) {
    for (const f of c.needs ?? [])
      if (!file.fixtures?.[f]) problems.push(`${id} needs fixture ${f}, which is not defined`);
    for (const a of c.after ?? []) {
      if (!file.cases[a]) problems.push(`${id} runs after ${a}, which is not a case`);
      if (a === id) problems.push(`${id} runs after itself`);
    }
  }
  if (problems.length > 0) throw new Error(`Not a valid case file: ${problems.join('; ')}`);
  runOrder(file, Object.keys(file.cases)); // throws on a cycle
  return file;
}

/**
 * The version of a case: its text, its commands and those of the fixtures it needs, so a changed
 * case or setup reads as a new version.
 */
export function caseHash(c: CaseDef, fixtures: CaseFile['fixtures'] = {}): string {
  const { title, steps, expected, needs, after, block } = c;
  const setup = (needs ?? []).map(f => [f, fixtures[f] ?? null]);
  return createHash('sha256')
    .update(JSON.stringify({ title, steps, expected, needs, after, block, setup }))
    .digest('hex')
    .slice(0, 16);
}

/**
 * The cases to run, in order: the selected ones and the cases they run after, each after those
 * it depends on, otherwise in the file's order.
 */
export function runOrder(file: CaseFile, selected: string[]): string[] {
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, path: string[]) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting')
      throw new Error(
        `Not a valid case file: cases run after each other in a loop (${[...path, id].join(
          ' → ',
        )})`,
      );
    state.set(id, 'visiting');
    for (const a of file.cases[id]?.after ?? []) visit(a, [...path, id]);
    state.set(id, 'done');
    order.push(id);
  };
  const ids = Object.keys(file.cases);
  const wanted = new Set(selected);
  for (const id of ids) if (wanted.has(id)) visit(id, []);
  return order;
}

/**
 * Whether the runner judges a case from its checks alone: it has expects, and every evidence read
 * (purpose verify) carries one.
 */
export const judgedByChecks = (c: CaseDef) =>
  c.block.some(call => call[2]?.expect) &&
  c.block.every(call => call[1].purpose !== 'verify' || call[2]?.expect);

/** The {{env.key}} placeholders a value uses. */
export function envKeys(value: unknown): string[] {
  const keys = new Set<string>();
  for (const m of JSON.stringify(value).matchAll(/\{\{env\.([a-zA-Z0-9_]+)\}\}/g)) keys.add(m[1]!);
  return [...keys];
}
