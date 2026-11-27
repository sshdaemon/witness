import { html, nothing } from 'lit';
import { api, type CaseDetail, type CaseRun, type Step } from '../api.js';
import {
  buildsLine,
  caseHref,
  checkList,
  crumbs,
  dur,
  empty,
  fmtTime,
  ICON,
  judged,
  plural,
  runHref,
  shortArgs,
  stepError,
  stepShots,
  ticketHref,
  verdict,
} from '../parts.js';
import type { Slide } from '../present.js';

export type CaseData = { detail: CaseDetail; chosen: CaseRun | undefined; steps: Step[] };

/** The case, and the steps it took in the chosen run (the newest unless one is picked). */
export async function loadCase(ticket: string, caseId: string, runId?: string): Promise<CaseData> {
  const detail = await api.caseOf(ticket, caseId);
  const newestFirst = detail.history.toReversed();
  const chosen = newestFirst.find(h => h.runId === runId) ?? newestFirst[0];
  const range = chosen?.run ? chosen.steps : null;
  const run = range ? await api.run(chosen!.runId) : null;
  const steps = run && range ? run.steps.filter(s => s.seq >= range.from && s.seq <= range.to) : [];
  return { detail, chosen, steps };
}

/** One slide per screenshot, and one for a step that took none. */
export const slidesOf = (steps: Step[]): Slide[] =>
  steps.flatMap(step => {
    const shots = stepShots(step);
    return (shots.length > 0 ? shots : [null]).map((src, frame) => ({
      step,
      src,
      frame,
      frames: shots.length,
    }));
  });

const list = (v: unknown[] | null) =>
  Array.isArray(v) && v.length > 0
    ? v.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ')
    : '';

function definition(def: CaseDetail['definition']) {
  if (!def) return html`<p class="note">No case definition stored yet: results only.</p>`;
  return html`<sl-card class="definition">
    ${
      Array.isArray(def.steps) && def.steps.length > 0
        ? html`<h3>Steps</h3>
            <ol>
              ${def.steps.map(s => html`<li>${s}</li>`)}
            </ol>`
        : nothing
    }
    ${
      def.expected
        ? html`<h3>Expected result</h3>
            <p>${def.expected}</p>`
        : nothing
    }
    ${list(def.needs) ? html`<div class="muted">Needs ${list(def.needs)}</div>` : nothing}
    ${list(def.after) ? html`<div class="muted">Runs after ${list(def.after)}</div>` : nothing}
    ${
      Array.isArray(def.block)
        ? html`<sl-details summary="Commands (${def.block.length})">
            <pre>${JSON.stringify(def.block, null, 2)}</pre>
          </sl-details>`
        : nothing
    }
  </sl-card>`;
}

export type CaseActions = { present: (slides: Slide[], index: number, title: string) => void };

/** A case: what it checks, a run picker, the chosen run's result and steps, and presentation. */
export function caseView({ detail: d, chosen, steps }: CaseData, act: CaseActions) {
  const def = d.definition;
  const title = `${d.caseId}${def?.title ? ` · ${def.title}` : ''}`;
  const newestFirst = d.history.toReversed();
  const slides = slidesOf(steps);
  const deckTitle = `${title}${chosen?.run?.label ? ` · ${chosen.run.label}` : ''}`;
  const open = (index: number) => act.present(slides, index, deckTitle);
  const slideAt = (seq: number, frame: number) =>
    Math.max(
      0,
      slides.findIndex(x => x.step.seq === seq && x.frame === frame),
    );

  const picker = newestFirst.map(h => {
    const name = (h.run?.label ?? (h.runNumber ? `run ${h.runNumber}` : h.runId)).replace(
      `${d.ticket} `,
      '',
    );
    return html`<sl-button
      size="small"
      pill
      variant=${h === chosen ? 'primary' : 'default'}
      href=${caseHref(d.ticket, d.caseId, h.runId)}
      title=${h.run ? fmtTime(h.run.started_at) : 'removed by retention'}
      >${ICON[h.result] ?? ''} ${name}</sl-button
    >`;
  });

  const runCard = (h: CaseRun) =>
    html`<sl-card class="run-result">
      <div slot="header" class="card-head">
        <span>
          ${
            h.run
              ? html`<a href=${runHref(h.runId)}>${h.run.label ?? h.runId}</a>
                  <span class="muted">· ${h.run.env} · ${fmtTime(h.run.started_at)}</span>`
              : html`run ${h.runNumber ?? '?'} <sl-tag size="small">removed</sl-tag>`
          }
        </span>
        <span class="right">
          ${
            h.earlierVersion
              ? html`<sl-tag
                  size="small"
                  title="The case has changed in its case file since this run"
                  >earlier version</sl-tag
                >`
              : nothing
          }
          ${judged(h)} ${verdict(h.result)}
        </span>
      </div>
      ${h.actual ? html`<p class="actual">${h.actual}</p>` : nothing}
      ${h.note ? html`<p class="muted">${h.note}</p>` : nothing} ${checkList(h.checks)}
      <div class="muted mono small">${buildsLine(h.app_versions)}</div>
      ${
        slides.length > 0
          ? html`<div slot="footer" class="card-foot">
              <sl-button variant="primary" @click=${() => open(0)}>
                <sl-icon slot="prefix" name="play-fill"></sl-icon>Present
              </sl-button>
              <span class="muted"
                >${plural(steps.length, 'step')},
                ${plural(slides.filter(x => x.src).length, 'screenshot')} · ← → to move, Esc to
                leave</span
              >
            </div>`
          : nothing
      }
    </sl-card>`;

  const stepItem = (s: Step) =>
    html`<li class="step ${s.ok ? '' : 'bad'}">
      <div class="row">
        <span class="seq">${s.seq}</span>
        <span class="tool">${s.tool}</span>
        <span class="args" title=${shortArgs(s.args)}>${shortArgs(s.args)}</span>
        <span class="spacer"></span>
        <span class="muted mono">${dur(s.durationMs)}</span>
        ${s.ok ? nothing : verdict('FAIL')}
      </div>
      ${stepError(s)}
      ${
        stepShots(s).length > 0
          ? html`<div class="thumbs">
              ${stepShots(s).map(
                (src, i) =>
                  html`<img
                    class="thumb"
                    loading="lazy"
                    src=${src}
                    alt="Screenshot ${i + 1} of step ${s.seq}, ${s.tool}"
                    @click=${() => open(slideAt(s.seq, i))}
                  />`,
              )}
            </div>`
          : nothing
      }
    </li>`;

  return html`
    ${crumbs([
      ['Tickets', '#/'],
      [d.ticket, ticketHref(d.ticket)],
      [d.caseId, null],
    ])}
    <div class="head">
      <h1>${title}</h1>
      ${newestFirst[0] ? verdict(newestFirst[0].result) : nothing}
    </div>
    ${definition(def)}
    ${
      chosen
        ? html`<h2>Runs</h2>
            <div class="run-picker" role="group" aria-label="Pick a run">${picker}</div>
            ${runCard(chosen)}
            ${
              steps.length > 0
                ? html`<h2>Steps in this run</h2>
                    <ol class="steps">
                      ${steps.map(stepItem)}
                    </ol>`
                : nothing
            }
            ${
              chosen.run && !chosen.steps
                ? html`<p class="note">
                    This result was recorded without case_begin, so it has no steps.
                  </p>`
                : nothing
            }`
        : empty('Not run yet.')
    }
    ${
      d.evidence.length > 0
        ? html`<h2>Evidence</h2>
            <div class="evidence-grid">
              ${d.evidence.map(
                e =>
                  html`<figure class="evidence">
                    <a href=${e.url} target="_blank" rel="noreferrer"
                      ><img class="thumb" loading="lazy" src=${e.url} alt=${e.caption}
                    /></a>
                    <figcaption>
                      ${e.caption}
                      <div class="muted">
                        <a href=${runHref(e.runId)}>step ${e.step}</a> ·
                        ${e.postedUrl ? 'posted' : 'not posted'}
                      </div>
                    </figcaption>
                  </figure>`,
              )}
            </div>`
        : nothing
    }
  `;
}
