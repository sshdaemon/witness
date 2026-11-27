import { html, nothing } from 'lit';
import { api, type RunRow, type Ticket } from '../api.js';
import { ago, fmtTime, plural } from '../format.js';
import { go, ticketHref } from '../links.js';
import { crumbs, empty } from '../parts/layout.js';
import { runsTable } from '../parts/runs.js';
import { barOf, countsOf, verdict } from '../parts/verdict.js';

const PAGE_SIZE = 15;

type Named = Ticket & { ticket: string };
const named = (t: Ticket): t is Named => t.ticket !== null;

/** Tickets as a table: the title first, then how its cases stand and how its last run went. */
const ticketsTable = (list: Named[]) =>
  html`<div class="table-wrap">
    <table class="tickets-table">
      <thead>
        <tr>
          <th>Ticket</th>
          <th>Use cases</th>
          <th>Last run</th>
          <th class="num">Runs</th>
          <th class="num">Tested</th>
        </tr>
      </thead>
      <tbody>
        ${list.map(t => {
          const href = ticketHref(t.ticket);
          return html`<tr
            class="link"
            tabindex="0"
            @click=${() => go(href)}
            @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && go(href)}
          >
            <td class="tk">
              <span class="title">${t.title ?? t.ticket}</span>
              ${t.title ? html`<span class="id">${t.ticket}</span>` : nothing}
            </td>
            <td class="cases">
              ${
                t.cases > 0
                  ? html`${barOf(t.counts)}${countsOf(t.counts)}`
                  : html`<span class="muted">none</span>`
              }
            </td>
            <td>${verdict(t.verdict)}</td>
            <td class="num">${t.runs}</td>
            <td class="num" title=${fmtTime(t.latest)}>${ago(t.latest)}</td>
          </tr>`;
        })}
      </tbody>
    </table>
  </div>`;

export const loadTickets = () => api.tickets();

/** Every ticket, the most recently tested first, a page at a time. */
export function ticketsView(tickets: Ticket[], page: number) {
  const tested = tickets.filter(named).filter(t => !t.tool);
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
        ? html`${ticketsTable(shown)}${pager}`
        : empty("Nothing tested yet. A session starts a ticket's run with session_start.")
    }
  `;
}

/** Tickets whose runs only exercised a tool, such as TOOL-search. */
export function toolsView(tickets: Ticket[]) {
  const tools = tickets.filter(named).filter(t => t.tool);
  return html`
    ${crumbs([
      ['Tickets', '#/'],
      ['Tool checks', null],
    ])}
    <div class="head"><h1>Tool checks</h1></div>
    <p class="sub">Runs that only exercised a tool while it was written.</p>
    ${tools.length > 0 ? ticketsTable(tools) : empty('No tool checks.')}
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
