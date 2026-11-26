import { isDeepStrictEqual } from 'node:util';
import type { DataExpect, ErrorExpect } from './caseFile.js';

export type Check = {
  seq: number;
  path: string;
  check: string;
  want?: unknown;
  got?: unknown;
  ok: boolean;
};

type Segment =
  | { key: string }
  | { index: number }
  | { all: true }
  | { field: string; value: string };

const SEGMENT = String.raw`(?:[^.[\]]+|\[(?:\*|\d+|[^=\]]+=[^\]]*)\])`;
const WHOLE_PATH = new RegExp(String.raw`^${SEGMENT}(?:\.?${SEGMENT})*$`);

/** "items[name=None].variants[0].stock" → its segments. */
export function parsePath(path: string): Segment[] {
  if (!WHOLE_PATH.test(path) || /\.(\.|\[|$)/.test(path)) throw new Error(`Not a path: ${path}`);
  const out: Segment[] = [];
  for (const m of path.matchAll(/([^.[\]]+)|\[(\*|\d+|[^=\]]+=[^\]]*)\]/g)) {
    if (m[1] !== undefined) out.push({ key: m[1] });
    else if (m[2] === '*') out.push({ all: true });
    else if (/^\d+$/.test(m[2]!)) out.push({ index: Number(m[2]) });
    else {
      const eq = m[2]!.indexOf('=');
      out.push({ field: m[2]!.slice(0, eq), value: m[2]!.slice(eq + 1) });
    }
  }
  return out;
}

/**
 * The values a path picks out of data. many is true when the path can pick several ([*] or
 * [field=value]), so a count counts them rather than the length of the one list it reached. found
 * is false when a key or index of the path was not there (a misspelled key), as opposed to a list
 * that is empty or a [field=value] that picks nothing.
 */
export function select(
  data: unknown,
  path: string,
): { values: unknown[]; many: boolean; found: boolean } {
  let values: unknown[] = [data];
  let many = false;
  let found = true;
  for (const s of parsePath(path)) {
    const next: unknown[] = [];
    for (const v of values) {
      if ('key' in s) {
        if (v && typeof v === 'object' && !Array.isArray(v) && s.key in v)
          next.push((v as Record<string, unknown>)[s.key]);
        else found = false;
      } else if ('index' in s) {
        if (Array.isArray(v) && s.index < v.length) next.push(v[s.index]);
        else found = false;
      } else if ('all' in s) {
        many = true;
        if (Array.isArray(v)) next.push(...v);
      } else {
        many = true;
        if (Array.isArray(v))
          next.push(
            ...v.filter(
              x =>
                x &&
                typeof x === 'object' &&
                String((x as Record<string, unknown>)[s.field]) === s.value,
            ),
          );
      }
    }
    values = next;
  }
  return { values, many, found };
}

/** Equal, or a text that contains the wanted text. */
const holds = (v: unknown, want: unknown) =>
  isDeepStrictEqual(v, want) ||
  (typeof v === 'string' && typeof want === 'string' && v.includes(want));

function contains(values: unknown[], many: boolean, want: unknown): boolean {
  if (!many && values.length === 1 && Array.isArray(values[0]))
    return values[0].some(x => holds(x, want));
  return values.some(v => holds(v, want));
}

/** Evaluates one expect on a successful call's data. */
export function checkData(e: DataExpect, data: unknown, seq: number): Check {
  let picked: ReturnType<typeof select>;
  try {
    picked = select(data, e.path);
  } catch (err) {
    return { seq, path: e.path, check: 'path', got: (err as Error).message, ok: false };
  }
  const { values, many, found } = picked;
  const got = many ? values : values[0];
  const base = { seq, path: e.path };
  if ('equals' in e)
    return {
      ...base,
      check: 'equals',
      want: e.equals,
      got,
      ok: values.length > 0 && values.every(v => isDeepStrictEqual(v, e.equals)),
    };
  if ('contains' in e)
    return {
      ...base,
      check: 'contains',
      want: e.contains,
      got,
      ok: contains(values, many, e.contains),
    };
  // A check that passes on nothing must not pass on a path that is not there.
  if (('excludes' in e || 'count' in e) && !found)
    return {
      ...base,
      check: 'excludes' in e ? 'excludes' : 'count',
      want: 'excludes' in e ? e.excludes : e.count,
      got: 'path not found',
      ok: false,
    };
  if ('excludes' in e)
    return {
      ...base,
      check: 'excludes',
      want: e.excludes,
      got,
      ok: !contains(values, many, e.excludes),
    };
  if ('matches' in e) {
    let re: RegExp;
    try {
      re = new RegExp(e.matches!);
    } catch {
      return {
        ...base,
        check: 'matches',
        want: e.matches,
        got: 'not a regular expression',
        ok: false,
      };
    }
    return {
      ...base,
      check: 'matches',
      want: e.matches,
      got,
      ok:
        values.length > 0 &&
        values.every(v => re.test(typeof v === 'string' ? v : JSON.stringify(v))),
    };
  }
  if ('count' in e) {
    const n =
      !many && values.length === 1 && Array.isArray(values[0]) ? values[0].length : values.length;
    return { ...base, check: 'count', want: e.count, got: n, ok: n === e.count };
  }
  // A reader answers null for what the page does not show, so null is not there.
  const present = values.some(v => v !== undefined && v !== null);
  return { ...base, check: 'exists', want: e.exists, got: present, ok: present === e.exists };
}

/** Evaluates an error expect: the call must have failed with that code and message. */
export function checkError(
  e: ErrorExpect,
  answer: { isError: boolean; code?: string; message?: string },
  seq: number,
): Check {
  const ok =
    answer.isError &&
    answer.code === e.error &&
    (!e.message || (answer.message ?? '').includes(e.message));
  return {
    seq,
    path: '(error)',
    check: 'error',
    want: e.message ? `${e.error}: …${e.message}…` : e.error,
    got: answer.isError ? `${answer.code}: ${answer.message ?? ''}`.slice(0, 300) : 'succeeded',
    ok,
  };
}
