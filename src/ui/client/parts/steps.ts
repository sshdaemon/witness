// A step as a person reads it: what it did, the few arguments that say which, its screenshots and
// its error, with the raw arguments and answer folded away.
import { html, nothing } from 'lit';
import type { Step } from '../api.js';
import { dur } from '../format.js';
import { verdict } from './verdict.js';

/** Steps that only mark where a case starts and ends; they show nothing a person needs. */
const MARKERS = new Set(['case_begin', 'case_end']);
export const isMarker = (s: Step) => MARKERS.has(s.tool);
export const shownSteps = (steps: Step[]) => steps.filter(s => !isMarker(s));

export const stepShots = (s: Step) => {
  if (s.screenshots.length > 0) return s.screenshots;
  return s.screenshot ? [s.screenshot] : [];
};

/** What the step did: its tool's title, or the tool's name in words for older steps. */
export const stepTitle = (s: Step) => {
  if (s.title) return s.title;
  const words = s.tool.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const SHORT = 40;
/** The step's plain arguments, a few of them and short, such as "actor booker · listing 3f2a". */
export const stepArgs = (s: Step) =>
  Object.entries(s.args ?? {})
    .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
    .slice(0, 3)
    .map(([k, v]) => {
      const text = String(v);
      return `${k} ${text.length > SHORT ? `${text.slice(0, SHORT)}…` : text}`;
    })
    .join(' · ');

export const stepError = (s: Step) => {
  if (s.ok) return nothing;
  const obs = s.observation ?? {};
  return html`<div class="err">
    <strong>${s.errorCode || obs.code || 'error'}</strong> ${obs.message ?? ''}
    ${obs.hint ? html`<span class="hint">— ${obs.hint}</span>` : nothing}
  </div>`;
};

/** One step in a list; a screenshot opens the presentation at that frame. */
export const stepItem = (s: Step, open: (seq: number, frame: number) => void) => {
  const shots = stepShots(s);
  const obs = s.observation ?? {};
  return html`<li class="step ${s.ok ? '' : 'bad'}">
    <div class="row">
      <span class="seq">${s.seq}</span>
      <span class="what">${stepTitle(s)}</span>
      <span class="args" title=${stepArgs(s)}>${stepArgs(s)}</span>
      <span class="spacer"></span>
      <span class="muted mono">${dur(s.durationMs)}</span>
      ${s.ok ? nothing : verdict('FAIL')}
    </div>
    ${stepError(s)}
    ${
      shots.length > 0
        ? html`<div class="thumbs">
            ${shots.map(
              (src, i) =>
                html`<img
                  class="thumb"
                  loading="lazy"
                  src=${src}
                  alt="Screenshot ${i + 1} of step ${s.seq}, ${stepTitle(s)}"
                  @click=${() => open(s.seq, i)}
                />`,
            )}
          </div>`
        : nothing
    }
    <details class="raw">
      <summary>Details</summary>
      <pre>${JSON.stringify({ tool: s.tool, args: s.args, result: obs.data ?? obs }, null, 2)}</pre>
    </details>
  </li>`;
};
