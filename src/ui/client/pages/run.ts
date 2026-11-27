import { html, nothing } from 'lit';
import { api, type RunDetail, type Step } from '../api.js';
import { buildLabel, dur, fmtTime, plural, runMs, runName } from '../format.js';
import { caseHref, go, runHref, ticketHref } from '../links.js';
import { checkList, summaryLines } from '../parts/checks.js';
import { crumbs, empty } from '../parts/layout.js';
import { isMarker, stepItem } from '../parts/steps.js';
import { resultCell, verdict } from '../parts/verdict.js';
import { slidesOf, type Slide } from '../present.js';

export const loadRun = (id: string) => api.run(id);

export type RunActions = { present: (slides: Slide[], index: number, title: string) => void };

/** A run: its result, builds, case results and every step, each case's steps under its own head. */
export function runView(d: RunDetail, act: RunActions) {
  const r = d.run;
  const ms = runMs(r);
  const failed = d.steps.filter(s => !s.ok).length;
  const slides = slidesOf(d.steps.filter(s => !isMarker(s)));
  const title = r.run_number ? `Run ${runName(r)}` : r.label || 'Run';
  const open = (seq: number, frame: number) =>
    act.present(
      slides,
      Math.max(
        0,
        slides.findIndex(x => x.step.seq === seq && x.frame === frame),
      ),
      title,
    );
  const startsAt = new Map(d.cases.filter(c => c.steps).map(c => [c.steps!.from, c]));
  const inCase = (seq: number) =>
    d.cases.some(c => c.steps && c.steps.from <= seq && seq <= c.steps.to);

  const step = (s: Step) => {
    const opens = startsAt.get(s.seq);
    // Steps after a case and before the next one (shared setup, cleanup) belong to no case.
    const leaves = !opens && d.cases.some(c => c.steps?.to === s.seq - 1) && !inCase(s.seq);
    return html`${
      opens
        ? html`<li class="case-head" id="case-${opens.caseId}">
            <a href=${caseHref(opens.ticket, opens.caseId, r.id)}
              >${opens.title ?? `Case ${opens.caseId}`}</a
            >
            ${verdict(opens.result)}
          </li>`
        : nothing
    }
    ${leaves ? html`<li class="case-head muted">Outside cases</li>` : nothing}
    ${isMarker(s) ? nothing : stepItem(s, open)}`;
  };

  return html`
    ${crumbs([
      ['Tickets', '#/'],
      r.ticket ? [r.ticket, ticketHref(r.ticket)] : ['No ticket', '#/no-ticket'],
      [title, null],
    ])}
    <div class="head">
      <h1>${title}</h1>
      ${verdict(r.verdict)}
      ${
        slides.some(x => x.src)
          ? html`<sl-button size="small" @click=${() => act.present(slides, 0, title)}>
              <sl-icon slot="prefix" name="play-fill"></sl-icon>Present
            </sl-button>`
          : nothing
      }
    </div>
    <div class="meta">
      <span>${r.env}</span>
      ${r.branch ? html`<span>testing <span class="mono">${r.branch}</span></span>` : nothing}
      ${Object.entries(r.app_versions ?? {}).map(
        ([name, b]) => html`<span>${name} <span class="mono">${buildLabel(b)}</span></span>`,
      )}
      <span>run tag <span class="mono">${r.run_tag}</span></span>
      <span title=${r.started_at}>${fmtTime(r.started_at)}</span>
      <span>${ms != null ? dur(ms) : 'still running'}</span>
      <span>${plural(d.steps.length, 'step')}${failed ? `, ${failed} failed` : ''}</span>
      ${
        d.lanes.length > 1
          ? html`<span
              >lane ${r.lane} of ${d.lanes.length}:
              ${d.lanes.map(l =>
                l.id === r.id
                  ? html`<strong>${l.lane}</strong> `
                  : html`<a href=${runHref(l.id)}>${l.lane}</a> `,
              )}</span
            >`
          : nothing
      }
      <span class="mono muted">${r.id}</span>
    </div>
    ${
      r.summary
        ? html`<div class="summary v-${r.verdict ?? 'RUNNING'}">${summaryLines(r.summary)}</div>`
        : nothing
    }
    ${
      d.cases.length > 0
        ? html`<h2>Cases</h2>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Use case</th>
                    <th>Result</th>
                    <th>What it showed</th>
                  </tr>
                </thead>
                <tbody>
                  ${d.cases.map(
                    c =>
                      html`<tr
                        class="link"
                        tabindex="0"
                        @click=${() => go(caseHref(c.ticket, c.caseId, r.id))}
                        @keydown=${(e: KeyboardEvent) =>
                          e.key === 'Enter' && go(caseHref(c.ticket, c.caseId, r.id))}
                      >
                        <td>${c.title ?? `Case ${c.caseId}`}</td>
                        <td>${resultCell(c)}</td>
                        <td>
                          ${c.actual ?? ''}
                          ${c.note ? html`<div class="muted">${c.note}</div>` : nothing}
                          ${checkList(c.checks.filter(k => !k.ok))}
                        </td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
        : nothing
    }
    <h2>Steps</h2>
    <p class="note">
      Yellow on a screenshot marks what the step changed, checked, configured or searched.
    </p>
    ${
      d.steps.length > 0
        ? html`<ol class="steps">
            ${d.steps.map(step)}
          </ol>`
        : empty('No steps recorded.')
    }
    <h2>Evidence on disk</h2>
    <div class="evidence">
      ${
        d.artifacts.filter(a => a.kind !== 'screenshot').length > 0
          ? d.artifacts
              .filter(a => a.kind !== 'screenshot')
              .map(
                a =>
                  html`<div class="ev">
                    <sl-tag size="small">${a.kind}</sl-tag>
                    <code>${a.openWith}</code>
                    <sl-copy-button value=${a.openWith}></sl-copy-button>
                  </div>`,
              )
          : empty('No traces or logs recorded.')
      }
    </div>
    <p class="note">
      Traces and logs can contain cookies and tokens, so this page never serves them. Open a trace
      with the command above.
    </p>
  `;
}
