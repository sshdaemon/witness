import { z } from 'zod';
import { prose } from '../prose.js';

/**
 * Who a run is for, put after the run tag in the names the tools make. Letters, digits, spaces and
 * hyphens only, so it passes name checks in the app.
 */
export const runLabel = z
  .string()
  .trim()
  .min(2)
  .max(24)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 -]*$/, 'letters, digits, spaces and hyphens only')
  .transform(s => s.replaceAll(/\s+/g, ' '))
  .describe(
    prose`
      Who this run is for: the ticket or PR and the run number for it, for example 'AB-12 run 3'
      or 'PR 42 run 1'. Put after the run tag in every name the tools make, so screenshots say
      what they show.`,
  );

const join = (...parts: (string | undefined)[]) => parts.filter(p => p && p.trim()).join(' ');

/**
 * A name for something a run creates: the run tag, then the label, then the words, within max
 * characters. Words that already start with the tag (and label) are not prefixed again. When the
 * name does not fit, whole words are dropped from the end, then all of them, and the label goes
 * only when even the tag and label do not fit. With keepWords the label goes before the words do.
 */
export function runName(
  tag: string,
  label: string | undefined,
  words: string,
  max = Number.POSITIVE_INFINITY,
  opts: { keepWords?: boolean } = {},
): string {
  const head = join(tag, label);
  let rest = words.trim();
  for (const prefix of [head, tag, label ?? '']) {
    if (prefix && (rest === prefix || rest.startsWith(`${prefix} `))) {
      rest = rest.slice(prefix.length).trim();
      break;
    }
  }
  // Words that tell several things apart (ticket names) matter more than the label: drop the label
  // before them.
  const keepLabel = !(opts.keepWords && rest && join(head, rest).length > max);
  const start = keepLabel ? head : tag;
  const kept = rest.split(/\s+/).filter(Boolean);
  while (kept.length > 0) {
    const name = join(start, kept.join(' '));
    if (name.length <= max) return name;
    kept.pop();
  }
  if (head.length <= max) return head;
  const plain = join(tag, rest);
  return plain.length <= max ? plain : tag.slice(0, max);
}
