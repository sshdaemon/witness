import { html, nothing } from 'lit';
import { api, type EvidenceTicket, type RunDetail, type Step } from '../api.js';
import {
  buildLabel,
  caseHref,
  checkList,
  crumbs,
  dur,
  empty,
  fmtTime,
  judged,
  plural,
  runHref,
  runMs,
  runName,
  shortArgs,
  stepError,
  stepShots,
  summaryLines,
  ticketHref,
  verdict,
} from '../parts.js';
import type { Slide } from '../present.js';
import { slidesOf } from './case.js';

export const loadRun = (id: string) => api.run(id);
export const loadEvidence = () => api.evidence();

export type RunActions = { present: (slides: Slide[], index: number, title: string) => void };

/** A run: its result, builds, case results and every step, each case's steps under its own head. */
export function runView(d: RunDetail, act: RunActions) {
  const r = d.run;
  const ms = runMs(r);
  const failed = d.steps.filter(s => !s.ok).length;
  const slides = slidesOf(d.steps);
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
    const obs = s.observation ?? {};
    return html`${
        opens
          ? html`<li class="case-head" id="case-${opens.caseId}">
              <a href=${caseHref(opens.ticket, opens.caseId, r.id)}>${opens.caseId}</a>
              ${verdict(opens.result)}
              <span class="muted">steps ${opens.steps!.from}–${opens.steps!.to}</span>
            </li>`
          : nothing
      }
      ${leaves ? html`<li class="case-head muted">Outside cases</li>` : nothing}
      <li class="step ${s.ok ? '' : 'bad'}">
        <div class="row">
          <span class="seq">${s.seq}</span>
          <span class="tool">${s.tool}</span>
          <span class="args" title=${shortArgs(s.args)}>${shortArgs(s.args)}</span>
          <span class="spacer"></span>
          ${s.pageKind ? html`<sl-tag size="small">${s.pageKind}</sl-tag>` : nothing}
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
                      alt="Screenshot ${i + 1} after ${s.tool}"
                      @click=${() => open(s.seq, i)}
                    />`,
                )}
              </div>`
            : nothing
        }
        <details>
          <summary>Details</summary>
          <pre>${JSON.stringify({ args: s.args, result: obs.data ?? obs }, null, 2)}</pre>
        </details>
      </li>`;
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
                    <th>Case</th>
                    <th>Result</th>
                    <th>Steps</th>
                    <th>What it showed</th>
                  </tr>
                </thead>
                <tbody>
                  ${d.cases.map(
                    c =>
                      html`<tr>
                        <td><a href=${caseHref(c.ticket, c.caseId, r.id)}>${c.caseId}</a></td>
                        <td>${verdict(c.result)} ${judged(c)}</td>
                        <td class="num">
                          ${
                            c.steps
                              ? `${c.steps.from}–${c.steps.to}`
                              : html`<span class="muted">–</span>`
                          }
                        </td>
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

/** Screenshots picked for tickets with evidence_pick. */
export function evidenceView(tickets: EvidenceTicket[]) {
  return html`
    ${crumbs([
      ['Tickets', '#/'],
      ['Evidence', null],
    ])}
    <div class="head"><h1>Evidence</h1></div>
    <p class="sub">
      Screenshots picked for tickets with evidence_pick. They are copies, kept after their runs are
      removed.
    </p>
    ${
      tickets.length > 0
        ? tickets.map(
            t =>
              html`<h2>
                  <a href=${ticketHref(t.ticket)}>${t.ticket}</a>
                  <span class="muted"
                    >· ${plural(t.items.length, 'screenshot')},
                    ${t.items.filter(e => e.postedUrl).length} posted</span
                  >
                </h2>
                <div class="evidence-grid">
                  ${t.items.map(
                    e =>
                      html`<figure class="evidence">
                        <a href=${e.url} target="_blank" rel="noreferrer"
                          ><img class="thumb" loading="lazy" src=${e.url} alt=${e.caption}
                        /></a>
                        <figcaption>
                          ${
                            e.case
                              ? html`<a href=${caseHref(t.ticket, e.case)}
                                  ><sl-tag size="small">${e.case}</sl-tag></a
                                > `
                              : nothing
                          }${e.caption}
                          <div class="muted">
                            <a href=${runHref(e.runId)}>step ${e.step}</a> ${e.tool ?? ''} ·
                            ${
                              e.postedUrl
                                ? html`<a href=${e.postedUrl} rel="noreferrer" target="_blank"
                                    >posted</a
                                  >`
                                : 'not posted'
                            }
                            ·
                            <sl-copy-button
                              value=${e.file}
                              copy-label="Copy the file path"
                            ></sl-copy-button>
                          </div>
                        </figcaption>
                      </figure>`,
                  )}
                </div>`,
          )
        : empty("No evidence yet. evidence_pick keeps a step's screenshot for a ticket.")
    }
  `;
}
