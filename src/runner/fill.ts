import { app } from '../app.js';

/** What earlier calls returned, for the placeholders of later ones. */
export type Vars = {
  TAG?: string;
  /** Values the app's tools leave ({{NAME}}), and lists of them ({{NAME1}}, {{NAME2}}, …). */
  values: Record<string, string>;
  lists: Record<string, string[]>;
  /** Data saved with {"as": name}, merged across calls. */
  named: Record<string, Record<string, unknown>>;
  env: Record<string, string>;
};

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)?)\}\}/g;

function lookup(name: string, vars: Vars): unknown {
  if (name === 'TAG') return vars.TAG || undefined;
  if (Object.hasOwn(vars.values, name)) return vars.values[name] || undefined;
  const nth = /^([A-Z]+)(\d+)$/.exec(name);
  if (nth && Object.hasOwn(vars.lists, nth[1]!)) return vars.lists[nth[1]!]![Number(nth[2]) - 1];
  const dot = name.indexOf('.');
  if (dot > 0) {
    const [head, field] = [name.slice(0, dot), name.slice(dot + 1)];
    if (head === 'env') return vars.env[field];
    return vars.named[head]?.[field];
  }
  return undefined;
}

/** Keeps what the app says a tool's result leaves for later calls. */
export function capture(tool: string, data: Record<string, unknown>, vars: Vars) {
  for (const { name, field, list } of app().runner?.capture?.[tool] ?? []) {
    const got = data[field];
    if (got === undefined || got === null || got === '') continue;
    if (list) (vars.lists[name] ??= []).push(String(got));
    else vars.values[name] = String(got);
  }
}

/** Placeholders that hold the last or the nth value of the whole run, as a pattern. */
export function runWidePattern(): RegExp | undefined {
  const names = Object.values(app().runner?.capture ?? {})
    .flat()
    .map(c => (c.list ? `${c.name}\\d+` : c.name));
  return names.length > 0
    ? new RegExp(`\\{\\{(${[...new Set(names)].join('|')})\\}\\}`, 'g')
    : undefined;
}

/**
 * Fills the placeholders in a call's args. A string that is one placeholder takes the value as it
 * is (a number stays a number); inside longer text it is written as text. Placeholders with no
 * value are listed in missing and left as they are.
 */
export function fill<T>(value: T, vars: Vars): { value: T; missing: string[] } {
  const missing = new Set<string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const whole = /^\{\{([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)?)\}\}$/.exec(v);
      if (whole) {
        const got = lookup(whole[1]!, vars);
        if (got === undefined || got === null) missing.add(whole[1]!);
        return got ?? v;
      }
      return v.replace(PLACEHOLDER, (all, name: string) => {
        const got = lookup(name, vars);
        if (got === undefined || got === null) {
          missing.add(name);
          return all;
        }
        return typeof got === 'string' ? got : JSON.stringify(got);
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value) as T, missing: [...missing] };
}
