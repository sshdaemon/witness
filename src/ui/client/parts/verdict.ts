// Verdicts: badges, dots, counts, the case bar and a result with who judged it.
import { html, nothing } from 'lit';
import { ref } from 'lit/directives/ref.js';
import type { CaseResult, Verdict } from '../api.js';

export const ICON: Record<string, string> = {
  PASS: '✓',
  FAIL: '✕',
  BLOCKED: '!',
  ABORTED: '–',
  RUNNING: '…',
  NOT_RUN: '○',
};
const WORD: Record<string, string> = { NOT_RUN: 'NOT RUN' };
export const word = (v: string) => WORD[v] ?? v;
const VARIANT: Record<string, string> = {
  PASS: 'success',
  FAIL: 'danger',
  BLOCKED: 'warning',
  ABORTED: 'neutral',
  NOT_RUN: 'neutral',
  RUNNING: 'primary',
};
const ORDER: Verdict[] = ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'];

export const verdict = (v: string | null | undefined) => {
  const k = v || 'RUNNING';
  return html`<sl-badge
    class="verdict"
    variant=${VARIANT[k] ?? 'neutral'}
    pill
    ?pulse=${k === 'RUNNING'}
    ><span aria-hidden="true">${ICON[k] ?? ''}</span>&nbsp;${word(k)}</sl-badge
  >`;
};

export const dot = (v: string, title: string) =>
  html`<span class="dot v-${v}" title=${title}>${ICON[v] ?? '?'}</span>`;

export const countsOf = (counts: Partial<Record<string, number>>) =>
  html`<span class="counts"
    >${ORDER.filter(v => counts[v]).map(
      v => html`<span class="count v-${v}" title=${word(v)}>${ICON[v]} ${counts[v]}</span>`,
    )}</span
  >`;

// The page's policy refuses inline style attributes, so widths are set on the element itself.
const grow = (n: number) => (el?: Element) => {
  if (el instanceof HTMLElement) el.style.flexGrow = String(n);
};

/** How the cases stand, as a thin bar in the verdict colours. */
export const barOf = (counts: Partial<Record<string, number>>) => {
  const shown = ORDER.filter(v => counts[v]);
  if (shown.length === 0) return html`<span class="bar empty" aria-hidden="true"></span>`;
  return html`<span class="bar" aria-hidden="true"
    >${shown.map(v => html`<i class="v-${v}" ${ref(grow(counts[v] ?? 0))}></i>`)}</span
  >`;
};

export const tally = (results: (string | null | undefined)[]) => {
  const out: Partial<Record<string, number>> = {};
  for (const r of results) if (r) out[r] = (out[r] ?? 0) + 1;
  return out;
};

/** Who decided the result: the checks alone, or the session, which may have overruled them. */
export const judged = (r: Pick<CaseResult, 'judgedBy' | 'checksResult' | 'result'>) => {
  if (r.judgedBy === 'checks') return mark('clipboard-check', 'Judged by its checks', '');
  if (r.checksResult && r.checksResult !== r.result)
    return mark(
      'exclamation-triangle',
      `The session overrode its checks, which gave ${word(r.checksResult)}`,
      'warn',
    );
  return nothing;
};

/** A small icon that explains itself on hover. */
const mark = (icon: string, text: string, tone: string) =>
  html`<sl-tooltip content=${text}
    ><sl-icon class="mark ${tone}" name=${icon} label=${text}></sl-icon
  ></sl-tooltip>`;

/** A case's result on one line: the verdict, who judged it and whether its build is older. */
export const resultCell = (
  r: Pick<CaseResult, 'judgedBy' | 'checksResult' | 'result'>,
  olderBuild?: string,
) =>
  html`<span class="result"
    >${verdict(r.result)}${judged(r)}${
      olderBuild
        ? mark('clock-history', `Last ran on an older build: ${olderBuild}`, 'warn')
        : nothing
    }</span
  >`;
