import { html, nothing } from 'lit';
import { api, type CaseDetail, type CaseRun, type Step } from '../api.js';
import { buildsLine, dur, plural, ranAt, shortArgs } from '../format.js';
import { caseHref, runHref, ticketHref } from '../links.js';
import { checkList } from '../parts/checks.js';
import { crumbs, empty } from '../parts/layout.js';
import { stepError, stepShots } from '../parts/steps.js';
import { dot, resultCell, verdict, word } from '../parts/verdict.js';
import { slidesOf, type Slide } from '../present.js';

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

/** A case's run by its number, with its lane when it ran in one. */
const runNo = (h: CaseRun) =>
  h.runNumber
    ? `Run #${h.runNumber}${h.run?.lane ? ` lane ${h.run.lane}` : ''}`
    : (h.run?.label ?? `Run ${h.runId}`);

export type CaseActions = { present: (slides: Slide[], index: number, title: string) => void };

/** A case: what it checks, a run picker, the chosen run's result and steps, and presentation. */
export function caseView({ detail: d, chosen, steps }: CaseData, act: CaseActions) {
  const def = d.definition;
  const title = `${d.caseId}${def?.title ? ` · ${def.title}` : ''}`;
  const newestFirst = d.history.toReversed();
  const slides = slidesOf(steps);
  const deckTitle = `${title}${chosen?.runNumber ? ` · run #${chosen.runNumber}` : ''}`;
  const open = (index: number) => act.present(slides, index, deckTitle);
  const slideAt = (seq: number, frame: number) =>
    Math.max(
      0,
      slides.findIndex(x => x.step.seq === seq && x.frame === frame),
    );

  // Every run of the case, newest first: its number, result, when it ran and how long it took.
  const picker = html`<nav class="run-list" aria-label="Runs of this case">
    ${newestFirst.map(
      h =>
        html`<a
          class="run-item ${h === chosen ? 'on' : ''}"
          href=${caseHref(d.ticket, d.caseId, h.runId)}
          aria-current=${h === chosen ? 'true' : 'false'}
        >
          ${dot(h.result, word(h.result))}
          <span class="no">${runNo(h).replace(/^Run /, '')}</span>
          <span class="muted"
            >${h.run ? ranAt(h.run.started_at, h.run.finished_at) : 'removed by retention'}</span
          >
        </a>`,
    )}
  </nav>`;

  const runCard = (h: CaseRun) =>
    html`<sl-card class="run-result">
      <div slot="header" class="card-head">
        <span>
          ${
            h.run
              ? html`<a href=${runHref(h.runId)}>${runNo(h)}</a>
                  <span class="muted"
                    >· ${h.run.env} · ${ranAt(h.run.started_at, h.run.finished_at)}</span
                  >`
              : html`${runNo(h)} <sl-tag size="small">removed</sl-tag>`
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
          ${resultCell(h)}
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
      <div class="titles">
        <div class="tid">${d.ticket} · ${d.caseId}</div>
        <h1>${def?.title ?? d.caseId}</h1>
      </div>
      ${newestFirst[0] ? verdict(newestFirst[0].result) : nothing}
    </div>
    ${definition(def)}
    ${
      chosen
        ? html`<h2>Runs</h2>
            ${picker} ${runCard(chosen)}
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
