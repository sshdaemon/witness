import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  caseHash,
  envKeys,
  judgedByChecks,
  runOrder,
  type Call,
  type CaseFile,
} from './caseFile.js';
import { runWidePattern } from './fill.js';

export type Promotion = {
  suite: CaseFile;
  /** Each promoted case, from its id in the ticket's file to its id in the suite. */
  added: { from: string; to: string }[];
  /** Cases the suite already had, unchanged. */
  kept: { from: string; to: string }[];
  /** The fixtures copied into the suite, by their names there. */
  fixtures: string[];
};

/** The `as` names a list of calls saves data under. */
const asNames = (calls: Call[]) => calls.flatMap(c => (c[2]?.as ? [c[2].as] : []));

/**
 * Renames {{name.…}} placeholders and {"as": "name"} options in one pass, so a name already
 * renamed is never renamed again.
 */
function renameAll<T>(value: T, names: Map<string, string>): T {
  const text = JSON.stringify(value).replaceAll(
    /\{\{([A-Za-z][A-Za-z0-9_]*)\.|"as":"([A-Za-z][A-Za-z0-9_]*)"/g,
    (whole, read?: string, saved?: string) => {
      const name = read ?? saved!;
      const to = names.get(name);
      if (!to) return whole;
      return read ? `{{${to}.` : `"as":"${to}"`;
    },
  );
  return JSON.parse(text) as T;
}

const fresh = (name: string, taken: Set<string>) => {
  let n = 2;
  while (taken.has(`${name}${n}`)) n++;
  return `${name}${n}`;
};

/**
 * Copies cases of a ticket's case file into a regression suite: each case with the cases it runs
 * after, the fixtures it needs, the env values and logins it uses. Cases get the suite's next ids
 * (R1, R2, …) and carry the version they came from, which covers the cases they run after: a case
 * promoted before is kept unless something new runs after it, and a new case brings fresh copies
 * of every case it runs after. Fixtures are copied, never merged with the suite's; a fixture name
 * or a name data is saved under that the suite already uses is renamed, so no two parts of a suite
 * run write the same data. Only cases the runner judges from their checks can
 * go in, as a suite runs with nobody to judge it.
 */
export function promote(source: CaseFile, ids: string[], suite: CaseFile): Promotion {
  const unknown = ids.filter(id => !source.cases[id]);
  if (unknown.length > 0) throw new Error(`Not cases of ${source.ticket}: ${unknown.join(', ')}`);
  const wanted = runOrder(source, ids);
  const unjudged = wanted.filter(id => !judgedByChecks(source.cases[id]!));
  if (unjudged.length > 0)
    throw new Error(
      `${unjudged.join(', ')} would need someone to judge them: give every evidence read an ` +
        'expect first.',
    );

  const out: CaseFile = structuredClone(suite);
  const added: Promotion['added'] = [];
  const kept: Promotion['kept'] = [];
  const newId = new Map<string, string>();

  // A case's version covers the cases it runs after, so a chain moves to a new version together.
  const origins = new Map<string, string>();
  const origin = (id: string): string => {
    const known = origins.get(id);
    if (known) return known;
    const def = source.cases[id]!;
    const value = createHash('sha256')
      .update(
        JSON.stringify([caseHash(def, source.fixtures), ...(def.after ?? []).map(a => origin(a))]),
      )
      .digest('hex')
      .slice(0, 16);
    origins.set(id, value);
    return value;
  };
  // Kept: a case the suite has in this version that nothing new runs after. A case added after
  // others brings fresh copies of all of them, so a chain always runs on its own data.
  const copied = new Set(
    wanted.filter(id => !Object.values(out.cases).some(c => c.origin === origin(id))),
  );
  const before = (id: string): string[] =>
    (source.cases[id]!.after ?? []).flatMap(a => [a, ...before(a)]);
  for (const id of copied) for (const a of before(id)) copied.add(a);
  const toAdd = wanted.filter(id => copied.has(id));
  for (const id of wanted.filter(caseId => !copied.has(caseId))) {
    const there = Object.entries(out.cases).find(([, c]) => c.origin === origin(id))!;
    newId.set(id, there[0]);
    kept.push({ from: id, to: there[0] });
  }
  const needed = [...new Set(toAdd.flatMap(id => source.cases[id]!.needs ?? []))];

  // Placeholders that mean "the nth or the last of the whole run": other cases' data in a suite.
  const runWide = runWidePattern();
  const wide = runWide
    ? [...toAdd.map(id => source.cases[id]), ...needed.map(f => source.fixtures?.[f])].flatMap(v =>
        [...JSON.stringify(v).matchAll(runWide)].map(m => m[0]),
      )
    : [];
  if (wide.length > 0)
    throw new Error(
      `${[...new Set(wide)].join(', ')} would read other cases' data in a suite: save the data ` +
        'with {"as": name} and use {{name.field}} instead.',
    );

  // Data a copied case reads must come from what is copied with it: a name saved by a case it does
  // not run after would read whatever the suite holds under that name.
  // What a case can read: what the cases it runs after saved, then what its own fixtures and calls
  // saved before the read, in the order they run. Nothing else is sure to run before it in a suite
  // run, its lane or a rerun.
  const savesOf = (id: string) => {
    const def = source.cases[id]!;
    return [
      ...(def.needs ?? []).flatMap(f => asNames(source.fixtures![f]!)),
      ...asNames(def.block),
    ];
  };
  const unsaved = toAdd.flatMap(id => {
    const def = source.cases[id]!;
    const readable = new Set(before(id).flatMap(savesOf));
    const missing = new Set<string>();
    for (const call of [...(def.needs ?? []).flatMap(f => source.fixtures![f]!), ...def.block]) {
      for (const m of JSON.stringify([call[1], call[2]?.expect]).matchAll(
        /\{\{([A-Za-z][A-Za-z0-9_]*)\./g,
      ))
        if (m[1] !== 'env' && !readable.has(m[1]!)) missing.add(m[1]!);
      if (call[2]?.as) readable.add(call[2].as);
    }
    return [...missing].map(name => `${id} reads ${name}`);
  });
  if (unsaved.length > 0)
    throw new Error(
      `${unsaved.join(', ')} before it or a case it runs after saves it: add the case that ` +
        'saves it to "after", so they always run together and in order.',
    );

  // New names: what the copied fixtures and added cases save, renamed where the suite has it.
  const suiteAs = new Set([
    ...Object.values(out.fixtures ?? {}).flatMap(asNames),
    ...Object.values(out.cases).flatMap(c => asNames(c.block)),
  ]);
  const ourAs = new Set([
    ...needed.flatMap(f => asNames(source.fixtures![f]!)),
    ...toAdd.flatMap(id => asNames(source.cases[id]!.block)),
  ]);
  const taken = new Set([...suiteAs, ...ourAs]);
  const asMap = new Map<string, string>();
  for (const name of ourAs)
    if (suiteAs.has(name)) {
      const to = fresh(name, taken);
      taken.add(to);
      asMap.set(name, to);
    }
  const fixtureMap = new Map<string, string>();
  const fixtureNames = new Set(Object.keys(out.fixtures ?? {}));
  for (const f of needed) {
    const to = fixtureNames.has(f) ? fresh(f, fixtureNames) : f;
    fixtureNames.add(to);
    fixtureMap.set(f, to);
  }

  for (const f of needed)
    out.fixtures = {
      ...out.fixtures,
      [fixtureMap.get(f)!]: renameAll(source.fixtures![f]!, asMap),
    };
  let next =
    Math.max(0, ...Object.keys(out.cases).map(k => Number(/^R(\d+)$/.exec(k)?.[1] ?? 0))) + 1;
  for (const id of toAdd) {
    const def = source.cases[id]!;
    const to = `R${next++}`;
    newId.set(id, to);
    out.cases[to] = {
      ...def,
      block: renameAll(def.block, asMap),
      ...(def.needs?.length ? { needs: def.needs.map(f => fixtureMap.get(f)!) } : {}),
      ...(def.after?.length ? { after: def.after.map(a => newId.get(a)!) } : {}),
      origin: origin(id),
    };
    added.push({ from: id, to });
  }

  // The env values the copied cases and fixtures use, per environment; a clash is refused.
  const used = new Set(
    envKeys([...added.map(a => out.cases[a.to]), ...needed.map(f => source.fixtures![f])]),
  );
  const clashes: string[] = [];
  for (const [env, values] of Object.entries(source.env ?? {})) {
    for (const key of used) {
      if (values[key] === undefined) continue;
      const have = out.env?.[env]?.[key];
      if (have !== undefined && have !== values[key]) clashes.push(`${env}.${key}`);
      else out.env = { ...out.env, [env]: { ...out.env?.[env], [key]: values[key] } };
    }
  }
  if (clashes.length > 0)
    throw new Error(`The suite already has other values for ${clashes.join(', ')}.`);

  // Logins every promoted case relies on.
  if (added.length > 0)
    for (const call of source.setup ?? [])
      if (!(out.setup ?? []).some(c => isDeepStrictEqual(c, call)))
        out.setup = [...(out.setup ?? []), call];

  return { suite: out, added, kept, fixtures: needed.map(f => fixtureMap.get(f)!) };
}

/** An empty suite for an area, named so it never reads as a ticket. */
export function newSuite(area: string): CaseFile {
  return {
    ticket: `REG-${area.toUpperCase()}`,
    topic: `Regression: ${area}`,
    cases: {},
  };
}
