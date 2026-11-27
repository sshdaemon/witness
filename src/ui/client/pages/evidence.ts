import { html, nothing } from 'lit';
import { api, type EvidenceTicket } from '../api.js';
import { plural } from '../format.js';
import { caseHref, runHref, ticketHref } from '../links.js';
import { crumbs, empty } from '../parts/layout.js';

export const loadEvidence = () => api.evidence();

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
