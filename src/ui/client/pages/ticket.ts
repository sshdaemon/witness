import { html, nothing, type TemplateResult } from 'lit';
import { api, type RunRow, type TicketDetail } from '../api.js';
import {
  ago,
  barOf,
  buildsLine,
  caseHref,
  countsOf,
  crumbs,
  dot,
  dur,
  fmtTime,
  go,
  ICON,
  judged,
  plural,
  runHref,
  runName,
  runsTable,
  served,
  summaryLines,
  tally,
  verdict,
  word,
} from '../parts.js';

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
  const name = column.label ?? (column.runNumber ? `run ${column.runNumber}` : 'Latest run');
  const one = lanes.length === 1 ? lanes[0] : undefined;
  const finished = lanes.every(l => l.finished_at);
  const span =
    first && finished
      ? Math.max(...lanes.map(l => new Date(l.finished_at!).getTime())) -
        new Date(first.started_at).getTime()
      : null;
  const steps = lanes.reduce((n, l) => n + l.steps, 0);
  const failed = lanes.reduce((n, l) => n + l.failed_steps, 0);
  return html`<sl-card class="last-run">
    <div slot="header" class="card-head">
      <span>
        ${one ? html`<a href=${runHref(one.id)}>${name}</a>` : html`<strong>${name}</strong>`}
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
      ${verdict(column.verdict)}
    </div>
    ${
      first
        ? html`<div class="stats">
            ${stat(
              'Started',
              html`<span title=${fmtTime(first.started_at)}>${ago(first.started_at)}</span>`,
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
    ${lanes
      .filter(l => l.summary)
      .toReversed()
      .map(
        l =>
          html`<div class="last-summary">
            ${lanes.length > 1 ? html`<strong>${runName(l)}</strong>` : nothing}
            ${summaryLines(l.summary!)}
          </div>`,
      )}
  </sl-card>`;
}

/** The run a column stands for, when it is one run and not a batch of lanes. */
const onlyLane = (r: Column) => (r.lanes.length === 1 ? r.lanes[0]?.id : undefined);

/** A run's column head: its number, linked when it is one run, and its lanes. */
const runHead = (r: Column) => {
  const name = r.runNumber ? `run ${r.runNumber}` : 'run';
  const title = r.pruned
    ? 'Removed by retention: its steps and screenshots are gone, its case results are kept.'
    : `${r.label ?? ''} · ${r.env ?? ''} · ${fmtTime(r.startedAt)}`;
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
                <td><a href=${caseHref(d.ticket, c.caseId)}>${c.caseId}</a></td>
                ${d.runs.map(r => {
                  const x = c.cells[r.id];
                  return html`<td class="cell">
                    ${
                      x
                        ? html`<a
                            class="dot v-${x.result}"
                            href=${caseHref(d.ticket, c.caseId, onlyLane(r))}
                            title="${c.caseId} ${word(x.result)} in ${r.label ?? r.id}"
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
    const x = lastColumn ? c.cells[lastColumn.id] : undefined;
    const now = c.current;
    return html`<tr
      class="link"
      tabindex="0"
      @click=${() => go(href)}
      @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && go(href)}
    >
      <td class="case-id"><a href=${href}>${c.caseId}</a></td>
      <td>${c.title ?? html`<span class="muted">no title</span>`}</td>
      <td>
        ${
          now
            ? html`${verdict(now.result)}
              ${
                now.olderBuild
                  ? html`<sl-tooltip content=${buildsLine(now.build)}
                      ><sl-tag size="small" variant="warning">older build</sl-tag></sl-tooltip
                    >`
                  : nothing
              }
              ${judged(now)}`
            : html`<span class="muted">never run</span>`
        }
      </td>
      <td>${x ? dot(x.result, word(x.result)) : html`<span class="muted">–</span>`}</td>
      <td class="num">
        ${now?.runNumber ? html`<span class="muted">run ${now.runNumber}</span>` : nothing}
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
      <h1>${d.ticket}</h1>
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
                    <th>Case</th>
                    <th>What it checks</th>
                    <th>Current result</th>
                    <th>Last run</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${d.cases.map(caseRow)}
                </tbody>
              </table>
            </div>
            <p class="note">
              Current is each case's latest result. Older build means it last ran on other builds
              than the newest run.
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
