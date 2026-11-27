// What a case or a run checked, as lists.
import { html, nothing, type TemplateResult } from 'lit';
import type { Check } from '../api.js';

const checkLine = (c: Check) =>
  html`<li class=${c.ok ? 'ok' : 'bad'}>
    <span aria-hidden="true">${c.ok ? '✓' : '✕'}</span> <span class="mono">${c.path}</span>
    ${c.check}${c.want === undefined ? '' : ` ${JSON.stringify(c.want)}`}
    ${c.ok ? nothing : html`<span class="badc">found ${JSON.stringify(c.got)}</span>`}
    <span class="muted">step ${c.seq}</span>
  </li>`;

export const checkList = (checks: Check[]) =>
  checks.length > 0
    ? html`<ul class="checks">
        ${checks.toSorted((a, b) => Number(a.ok) - Number(b.ok)).map(checkLine)}
      </ul>`
    : nothing;

// "ok: x; FAIL: y | note" is how sessions write checks in run_finish.
const splitSummary = (text: string) =>
  text
    .replaceAll(/^[\s|;]+|[\s|;]+$/g, '')
    .split(/;\s+|\s+\|\s+/)
    .map(l => l.trim())
    .filter(Boolean);

export const summaryLines = (text: string) =>
  html`<ul class="checks">
    ${splitSummary(text).map(line => {
      const m = /^(ok|FAIL):\s*(.*)$/.exec(line);
      if (!m) return html`<li class="plain">${line}</li>`;
      return m[1] === 'ok'
        ? html`<li class="ok"><span aria-hidden="true">✓</span> ${m[2]}</li>`
        : html`<li class="bad"><span aria-hidden="true">✕</span> ${m[2]}</li>`;
    })}
  </ul>`;

/** In a table row: counts, any failed check in full, and the whole list behind a click. */
export const compactChecks = (text: string | null): TemplateResult | typeof nothing => {
  const lines = splitSummary(text ?? '');
  if (lines.length === 0) return html`<span class="muted">–</span>`;
  const ok = lines.filter(l => l.startsWith('ok:')).length;
  const bad = lines.filter(l => l.startsWith('FAIL:'));
  const notes = lines.filter(l => !/^(ok|FAIL):/.test(l));
  if (!ok && bad.length === 0)
    return html`<div class="clamp" title=${lines.join('; ')}>${lines.join('; ')}</div>`;
  return html`<details class="rowchecks" @click=${(e: Event) => e.stopPropagation()}>
      <summary>
        ${ok ? html`<span class="okc">✓ ${ok} passed</span>` : nothing}
        ${bad.length > 0 ? html`<span class="badc">✕ ${bad.length} failed</span>` : nothing}
      </summary>
      ${summaryLines(text ?? '')}
    </details>
    ${bad.map(l => html`<div class="badc">${l.replace(/^FAIL:\s*/, '')}</div>`)}
    ${
      notes.length > 0
        ? html`<div class="clamp muted" title=${notes.join('; ')}>${notes.join('; ')}</div>`
        : nothing
    }`;
};
