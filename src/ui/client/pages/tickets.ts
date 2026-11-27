import { html, nothing } from 'lit';
import { api, type RunRow, type Ticket } from '../api.js';
import { ago, plural } from '../format.js';
import { ticketHref } from '../links.js';
import { crumbs, empty } from '../parts/layout.js';
import { runsTable } from '../parts/runs.js';
import { barOf, countsOf, verdict } from '../parts/verdict.js';

const PAGE_SIZE = 15;

const ticketRow = (t: Ticket & { ticket: string }) =>
  html`<li>
    <a class="ticket-row" href=${ticketHref(t.ticket)}>
      <span class="tk"
        ><span class="id">${t.ticket}</span>${
          t.title ? html`<span class="title">${t.title}</span>` : nothing
        }</span
      >
      <span class="cases"
        >${
          t.cases > 0
            ? html`${barOf(t.counts)}${countsOf(t.counts)}`
            : html`<span class="muted">no cases</span>`
        }</span
      >
      <span class="last"><span class="muted">last run</span> ${verdict(t.verdict)}</span>
      <span class="when muted"
        >${t.cases > 0 ? `${plural(t.cases, 'case')} · ` : ''}${plural(t.runs, 'run')} ·
        ${ago(t.latest)}</span
      >
      <sl-icon name="chevron-right" class="go" aria-hidden="true"></sl-icon>
    </a>
  </li>`;

const named = (t: Ticket): t is Ticket & { ticket: string } => t.ticket !== null;

export const loadTickets = () => api.tickets();

/** Every ticket, the most recently tested first, a page at a time. */
export function ticketsView(tickets: Ticket[], page: number) {
  const tested = tickets.filter(named).filter(t => !t.tool);
  const tools = tickets.filter(named).filter(t => t.tool);
  const noTicket = tickets.find(t => t.ticket === null);
  const pages = Math.max(1, Math.ceil(tested.length / PAGE_SIZE));
  const p = Math.min(Math.max(page, 1), pages);
  const shown = tested.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
  const pager =
    pages > 1
      ? html`<nav class="pager" aria-label="Pages">
          <sl-button size="small" href=${p > 1 ? `#/page/${p - 1}` : nothing} ?disabled=${p <= 1}>
            <sl-icon slot="prefix" name="chevron-left"></sl-icon>Newer
          </sl-button>
          <span class="muted">Page ${p} of ${pages}</span>
          <sl-button
            size="small"
            href=${p < pages ? `#/page/${p + 1}` : nothing}
            ?disabled=${p >= pages}
          >
            Older<sl-icon slot="suffix" name="chevron-right"></sl-icon>
          </sl-button>
        </nav>`
      : nothing;
  return html`
    <div class="head">
      <h1>Tickets</h1>
      <span class="muted">${plural(tested.length, 'ticket')}, most recently tested first</span>
    </div>
    ${
      shown.length > 0
        ? html`<ul class="tickets">
              ${shown.map(ticketRow)}
            </ul>
            ${pager}`
        : empty("Nothing tested yet. A session starts a ticket's run with session_start.")
    }
    ${
      tools.length > 0
        ? html`<sl-details class="more" summary="Tool checks (${tools.length})">
            <ul class="tickets">
              ${tools.map(ticketRow)}
            </ul>
          </sl-details>`
        : nothing
    }
    ${
      noTicket
        ? html`<a class="ticket-row quiet" href="#/no-ticket">
            <span class="tk">No ticket</span>
            <span class="muted"
              >${plural(noTicket.runs, 'run')} from before every run had a ticket ·
              ${ago(noTicket.latest)}</span
            >
            <sl-icon name="chevron-right" class="go" aria-hidden="true"></sl-icon>
          </a>`
        : nothing
    }
  `;
}

export const loadNoTicket = () => api.runs('');

export const noTicketView = (list: RunRow[]) => html`
  ${crumbs([
    ['Tickets', '#/'],
    ['No ticket', null],
  ])}
  <div class="head"><h1>Runs without a ticket</h1></div>
  <p class="sub">From before every run had a ticket.</p>
  ${runsTable(list)}
`;
