import { app } from '../app.js';
import type { CaseFile } from './caseFile.js';

/** The tools a case calls, its fixtures' included. */
const toolsOf = (file: CaseFile, id: string) => {
  const c = file.cases[id]!;
  return [...(c.needs ?? []).flatMap(f => file.fixtures?.[f] ?? []), ...c.block].map(
    call => call[0],
  );
};

/**
 * Cases that call a tool changing shared state without declaring it in `uses`, with the value they
 * should declare.
 */
export function undeclaredUses(file: CaseFile, ids: string[]): { caseId: string; uses: string }[] {
  const out: { caseId: string; uses: string }[] = [];
  const shared = app().runner?.sharedState ?? {};
  for (const id of ids) {
    const declared = new Set(file.cases[id]!.uses ?? []);
    for (const tag of new Set(
      toolsOf(file, id)
        .map(t => shared[t])
        .filter(Boolean),
    ))
      if (!declared.has(tag!)) out.push({ caseId: id, uses: tag! });
  }
  return out;
}

/**
 * Splits the cases to run into at most n lanes that share nothing: a case, the cases it runs
 * after, every case needing one of the same fixtures and every case with the same `uses` value
 * stay in one lane. Groups go to the lane with the least work, the largest first; each lane keeps
 * the run order it was given.
 */
export function planLanes(file: CaseFile, order: string[], n: number): string[][] {
  const parent = new Map(order.map(id => [id, id]));
  const find = (id: string): string => {
    const p = parent.get(id)!;
    if (p === id) return id;
    const root = find(p);
    parent.set(id, root);
    return root;
  };
  const join = (a: string, b: string) => parent.set(find(a), find(b));
  const firstBy = new Map<string, string>();
  const tie = (key: string, id: string) => {
    const other = firstBy.get(key);
    if (other) join(id, other);
    else firstBy.set(key, id);
  };
  for (const id of order) {
    const c = file.cases[id]!;
    for (const a of c.after ?? []) if (parent.has(a)) join(id, a);
    for (const f of c.needs ?? []) tie(`fixture:${f}`, id);
    for (const u of c.uses ?? []) tie(`uses:${u}`, id);
  }
  const groups = new Map<string, string[]>();
  for (const id of order) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);
  const weight = (ids: string[]) => ids.reduce((w, id) => w + toolsOf(file, id).length, 0);
  const lanes = Array.from({ length: Math.max(1, Math.min(n, groups.size)) }, () => ({
    ids: [] as string[],
    work: 0,
  }));
  for (const g of [...groups.values()].toSorted((a, b) => weight(b) - weight(a))) {
    const lane = lanes.reduce((least, l) => (l.work < least.work ? l : least));
    lane.ids.push(...g);
    lane.work += weight(g);
  }
  const at = new Map(order.map((id, i) => [id, i]));
  return lanes.map(l => l.ids.toSorted((a, b) => at.get(a)! - at.get(b)!));
}
