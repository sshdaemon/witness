// Formatting and the small pieces every page shares.
import { html, nothing, type TemplateResult } from 'lit';
import { ref } from 'lit/directives/ref.js';
import type { Build, Builds, CaseResult, Check, RunRow, Step, Verdict } from './api.js';

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

export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export const fmtTime = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

export const ago = (iso: string | null | undefined) => {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
};

export const dur = (ms: number | null | undefined) => {
  if (ms == null) return '';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
};

export const runMs = (r: { started_at: string; finished_at: string | null }) =>
  r.finished_at ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime() : null;

const isBuild = (b: unknown): b is Build => !!b && typeof b === 'object' && 'sha' in b;
export const buildLabel = (b: unknown) =>
  isBuild(b)
    ? `${b.branch ? b.branch.replace(/^(feat|fix|feature)\//, '') : 'detached'}@${b.sha}${
        b.dirty ? ' +local' : ''
      }`
    : '';
export const buildsLine = (builds: Builds | null) =>
  Object.entries(builds ?? {})
    .filter(([, b]) => isBuild(b))
    .map(([n, b]) => `${n} ${buildLabel(b)}`)
    .join(' · ');

export const runName = (r: { label: string | null; run_number?: number | null }) =>
  r.label || (r.run_number ? `run ${r.run_number}` : '');

export const shortArgs = (args: Record<string, unknown> | null) =>
  Object.entries(args ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(', ');

// ---- Links

export const ticketHref = (ticket: string) => `#/ticket/${encodeURIComponent(ticket)}`;
export const caseHref = (ticket: string, caseId: string, runId?: string) =>
  `${ticketHref(ticket)}/case/${encodeURIComponent(caseId)}${
    runId ? `/run/${encodeURIComponent(runId)}` : ''
  }`;
export const runHref = (id: string) => `#/run/${encodeURIComponent(id)}`;
export const go = (href: string) => {
  location.hash = href;
};

// ---- Pieces

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

/** Where the person is, as links back up; the last item has no link. */
export const crumbs = (items: [string, string | null][]) =>
  html`<sl-breadcrumb class="crumbs">
    ${items.map(([label, href]) =>
      href
        ? html`<sl-breadcrumb-item href=${href}>${label}</sl-breadcrumb-item>`
        : html`<sl-breadcrumb-item>${label}</sl-breadcrumb-item>`,
    )}
  </sl-breadcrumb>`;

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

/** Who decided the result: the checks alone, or the session, which may have overruled them. */
export const judged = (r: Pick<CaseResult, 'judgedBy' | 'checksResult' | 'result'>) => {
  if (r.judgedBy === 'checks') return html`<sl-tag size="small">by checks</sl-tag>`;
  if (r.checksResult && r.checksResult !== r.result)
    return html`<sl-tag size="small" variant="warning" title="The checks gave ${r.checksResult}"
      >overrode checks (${word(r.checksResult)})</sl-tag
    >`;
  return nothing;
};

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

/** The build serving the API (what is under test), with the other apps behind a hover. */
export const served = (builds: Builds | null) => {
  const entries = Object.entries(builds ?? {}).filter(([, b]) => isBuild(b));
  if (entries.length === 0) return html`<span class="muted">–</span>`;
  const main = entries.find(([name]) => name === 'api') ?? entries[0]!;
  const all = entries.map(([name, b]) => `${name}: ${buildLabel(b)}`).join('\n');
  return html`${main[0] === 'api' ? nothing : html`<span class="muted">${main[0]} </span>`}<span
      class="mono"
      title=${all}
      >${buildLabel(main[1])}</span
    >${entries.length > 1 ? html` <span class="muted">+${entries.length - 1}</span>` : nothing}`;
};

export const stepShots = (s: Step) => {
  if (s.screenshots.length > 0) return s.screenshots;
  return s.screenshot ? [s.screenshot] : [];
};

export const stepError = (s: Step) => {
  if (s.ok) return nothing;
  const obs = s.observation ?? {};
  return html`<div class="err">
    <strong>${s.errorCode || obs.code || 'error'}</strong> ${obs.message ?? ''}
    ${obs.hint ? html`<span class="hint">— ${obs.hint}</span>` : nothing}
  </div>`;
};

/** Runs as a table, newest first; a row opens its run. */
export const runsTable = (list: RunRow[]) =>
  list.length > 0
    ? html`<div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Result</th>
              <th>Started</th>
              <th>Env</th>
              <th>Served from</th>
              <th>Steps</th>
              <th>Duration</th>
              <th>What was checked</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(
              r =>
                html`<tr
                  class="link"
                  tabindex="0"
                  @click=${() => go(runHref(r.id))}
                  @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && go(runHref(r.id))}
                >
                  <td><a href=${runHref(r.id)}>${runName(r) || r.ticket || 'run'}</a></td>
                  <td>${verdict(r.verdict)}</td>
                  <td class="num" title=${fmtTime(r.started_at)}>${ago(r.started_at)}</td>
                  <td>${r.env}</td>
                  <td class="served">${served(r.app_versions)}</td>
                  <td class="num">
                    ${r.steps}${
                      r.failed_steps
                        ? html`<div class="badc">${r.failed_steps} failed</div>`
                        : nothing
                    }
                  </td>
                  <td class="num">${dur(runMs(r))}</td>
                  <td class="sum">${compactChecks(r.summary)}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>`
    : html`<div class="empty">No runs.</div>`;

export const empty = (text: string) => html`<div class="empty">${text}</div>`;
