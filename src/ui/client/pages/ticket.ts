import { html, nothing, type TemplateResult } from 'lit';
import { api, type RunRow, type TicketDetail } from '../api.js';
import { ago, buildsLine, dur, fmtTime, plural } from '../format.js';
import { caseHref, go, runHref } from '../links.js';
import { crumbs } from '../parts/layout.js';
import { runsTable, served } from '../parts/runs.js';
import { barOf, countsOf, ICON, resultCell, tally, verdict, word } from '../parts/verdict.js';

export type TicketData = { detail: TicketDetail; runs: RunRow[] };

export const loadTicket = async (ticket: string): Promise<TicketData> => {
  const [detail, runs] = await Promise.all([api.ticket(ticket), api.runs(ticket)]);
  return { detail, runs };
};

const stat = (label: string, value: TemplateResult | string) =>
  html`<div class="stat">
    <div class="label">${label}</div>
    <div class="value">${value}</div>
  </div>`;

type Column = TicketDetail['runs'][number];

/**
 * The newest run at a glance, its lanes taken together: the worst lane's verdict, when it started,
 * how long it took, its steps, how its cases went and the builds it ran against.
 */
function lastRunCard(column: Column, lanes: RunRow[], inLast: Partial<Record<string, number>>) {
  const first = lanes.at(-1); // newest first, so the earliest lane is last
  const name = column.runNumber ? `Run #${column.runNumber}` : 'Latest run';
  const one = lanes.length === 1 ? lanes[0] : undefined;
  const finished = lanes.every(l => l.finished_at);
  const span =
    first && finished
      ? Math.max(...lanes.map(l => new Date(l.finished_at!).getTime())) -
        new Date(first.started_at).getTime()
      : null;
  const steps = lanes.reduce((n, l) => n + l.steps, 0);
  const failed = lanes.reduce((n, l) => n + l.failed_steps, 0);
  // One run opens with a click anywhere on the card; a batch links each of its lanes instead.
  const openRun = (e: Event) => {
    if (!one || (e.target as Element).closest('a')) return;
    if (e instanceof KeyboardEvent && e.key !== 'Enter') return;
    go(runHref(one.id));
  };
  return html`<sl-card
    class="last-run ${one ? 'clickable' : ''}"
    tabindex=${one ? '0' : nothing}
    @click=${openRun}
    @keydown=${openRun}
  >
    <div slot="header" class="card-head">
      <span>
        <strong>${name}</strong>
        <span class="muted">latest run</span>
        ${
          lanes.length > 1
            ? html`<span class="lane-links"
                >${lanes
                  .toReversed()
                  .map(
                    (l, i) =>
                      html`<a href=${runHref(l.id)} title=${l.verdict ?? 'still open'}
                        >lane ${i + 1}</a
                      >`,
                  )}</span
              >`
            : nothing
        }
      </span>
      <span class="right">
        ${verdict(column.verdict)}
        ${one ? html`<sl-icon name="chevron-right" class="go"></sl-icon>` : nothing}
      </span>
    </div>
    ${
      first
        ? html`<div class="stats">
            ${stat(
              'Started',
              html`<span title=${ago(first.started_at)}>${fmtTime(first.started_at)}</span>`,
            )}
            ${stat('Env', first.env)} ${stat('Duration', finished ? dur(span) : 'still running')}
            ${stat(
              'Steps',
              html`${steps}${failed ? html` <span class="badc">${failed} failed</span>` : nothing}`,
            )}
            ${
              Object.keys(inLast).length > 0 ? stat('Cases in this run', countsOf(inLast)) : nothing
            }
            ${stat('Served from', served(first.app_versions))}
          </div>`
        : html`<p class="muted">Removed by retention: only its case results are kept.</p>
            ${Object.keys(inLast).length > 0 ? countsOf(inLast) : nothing}`
    }
  </sl-card>`;
}

/** The run a column stands for, when it is one run and not a batch of lanes. */
const onlyLane = (r: Column) => (r.lanes.length === 1 ? r.lanes[0]?.id : undefined);

/** A run's column head: its number, linked when it is one run, and its lanes. */
const runHead = (r: Column) => {
  const name = r.runNumber ? `#${r.runNumber}` : 'run';
  const title = r.pruned
    ? 'Removed by retention: its steps and screenshots are gone, its case results are kept.'
    : `${r.env ?? ''} · ${fmtTime(r.startedAt)}`;
  const one = r.lanes.length === 1 && !r.pruned ? r.lanes[0] : undefined;
  return html`<th class="runcol" title=${title}>
    ${
      one
        ? html`<a href=${runHref(one.id)}>${name}</a>`
        : html`<span class=${r.pruned ? 'muted' : ''}>${name}</span>`
    }
    ${
      r.lanes.length > 1
        ? html`<div class="lanes">
            ${r.lanes.map(l =>
              l.pruned
                ? html`<span class="muted">lane ${l.lane ?? '?'}</span>`
                : html`<a href=${runHref(l.id)} title=${l.verdict ?? 'still open'}
                    >lane ${l.lane ?? '?'}</a
                  >`,
            )}
          </div>`
        : nothing
    }
  </th>`;
};

/** Every case against every run. */
function grid(d: TicketDetail) {
  return html`<h3>Cases by run</h3>
    <div class="table-wrap">
      <table class="grid">
        <thead>
          <tr>
            <th>Case</th>
            ${d.runs.map(runHead)}
          </tr>
        </thead>
        <tbody>
          ${d.cases.map(
            c =>
              html`<tr>
                <td class="case-name">
                  <a href=${caseHref(d.ticket, c.caseId)}>${c.title ?? `Case ${c.caseId}`}</a>
                </td>
                ${d.runs.map(r => {
                  const x = c.cells[r.id];
                  return html`<td class="cell">
                    ${
                      x
                        ? html`<a
                            class="dot v-${x.result}"
                            href=${caseHref(d.ticket, c.caseId, onlyLane(r))}
                            title="${c.caseId} ${word(x.result)} in run #${r.runNumber ?? '?'}"
                            >${ICON[x.result] ?? '?'}</a
                          >`
                        : nothing
                    }
                  </td>`;
                })}
              </tr>`,
          )}
        </tbody>
      </table>
    </div>`;
}

/** A ticket: its use cases with their current result, the latest run, and the history folded. */
export function ticketView({ detail: d, runs }: TicketData) {
  const lastColumn = d.runs.at(-1);
  const laneIds = new Set(lastColumn?.lanes.map(l => l.id));
  const lastLanes = runs.filter(r => laneIds.has(r.id));
  const inLast = tally(d.cases.map(c => (lastColumn ? c.cells[lastColumn.id]?.result : null)));
  const current = tally(d.cases.map(c => c.current?.result));

  const caseRow = (c: TicketDetail['cases'][number]) => {
    const href = caseHref(d.ticket, c.caseId);
    const now = c.current;
    // Said only when the case did not run in the newest run, so its result is an older one.
    const older = now?.runNumber && lastColumn && !c.cells[lastColumn.id];
    return html`<tr
      class="link"
      tabindex="0"
      @click=${() => go(href)}
      @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && go(href)}
    >
      <td>${c.title ?? `Case ${c.caseId}`}</td>
      <td>
        ${
          now
            ? html`${resultCell(now, now.olderBuild ? buildsLine(now.build) : undefined)}
              ${older ? html`<span class="muted small">from #${now.runNumber}</span>` : nothing}`
            : html`<span class="muted">never run</span>`
        }
      </td>
      <td class="num">
        ${c.evidence ? html`<sl-tag size="small">${plural(c.evidence, 'shot')}</sl-tag>` : nothing}
      </td>
    </tr>`;
  };

  return html`
    ${crumbs([
      ['Tickets', '#/'],
      [d.ticket, null],
    ])}
    <div class="head">
      <div class="titles">
        ${d.title ? html`<div class="tid">${d.ticket}</div>` : nothing}
        <h1>${d.title ?? d.ticket}</h1>
      </div>
      ${lastColumn ? verdict(lastColumn.verdict) : nothing}
    </div>
    <div class="meta">
      <span>${plural(d.cases.length, 'case')}</span><span>${plural(runs.length, 'run')}</span>
      ${d.cases.length > 0 ? html`${barOf(current)}${countsOf(current)}` : nothing}
    </div>
    ${lastColumn ? lastRunCard(lastColumn, lastLanes, inLast) : nothing}
    <h2>Use cases</h2>
    ${
      d.cases.length > 0
        ? html`<div class="table-wrap">
              <table class="cases">
                <thead>
                  <tr>
                    <th>Use case</th>
                    <th>Result</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${d.cases.map(caseRow)}
                </tbody>
              </table>
            </div>
            <p class="note">
              Each case's latest result; "from #n" when the newest run did not include it. Hover an
              icon for who judged it, or whether it last ran on older builds.
            </p>`
        : html`<div class="empty">No cases recorded for this ticket; its runs are below.</div>`
    }
    <sl-details
      class="more"
      summary="Run history (${plural(runs.length, 'run')})"
      ?open=${d.cases.length === 0}
    >
      ${d.cases.length > 0 ? grid(d) : nothing}
      <h3>Runs</h3>
      ${runsTable(runs)}
    </sl-details>
  `;
}
