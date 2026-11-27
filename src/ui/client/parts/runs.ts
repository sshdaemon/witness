// Runs as a table, with the builds that served them.
import { html, nothing } from 'lit';
import type { Builds, RunRow } from '../api.js';
import { ago, buildLabel, dur, fmtTime, isBuild, runMs, runName } from '../format.js';
import { go, runHref } from '../links.js';
import { compactChecks } from './checks.js';
import { verdict } from './verdict.js';

/** The build serving the API (what is under test), with the other apps behind a hover. */
export const served = (builds: Builds | null) => {
  const entries = Object.entries(builds ?? {}).filter(([, b]) => isBuild(b));
  if (entries.length === 0) return html`<span class="muted">–</span>`;
  const main = entries.find(([name]) => name === 'api') ?? entries[0]!;
  const all = entries.map(([name, b]) => `${name}: ${buildLabel(b)}`).join('\n');
  return html`${main[0] === 'api' ? nothing : html`<span class="muted">${main[0]} </span>`}<span
      class="mono"
      title=${all}
      >${buildLabel(main[1])}</span
    >${entries.length > 1 ? html` <span class="muted">+${entries.length - 1}</span>` : nothing}`;
};

/** Runs as a table, newest first; a row opens its run. */
export const runsTable = (list: RunRow[]) =>
  list.length > 0
    ? html`<div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Result</th>
              <th>Started</th>
              <th>Env</th>
              <th>Served from</th>
              <th>Steps</th>
              <th>Duration</th>
              <th>What was checked</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(
              r =>
                html`<tr
                  class="link"
                  tabindex="0"
                  @click=${() => go(runHref(r.id))}
                  @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && go(runHref(r.id))}
                >
                  <td class="run-no">${runName(r) || 'run'}</td>
                  <td>${verdict(r.verdict)}</td>
                  <td class="num" title=${ago(r.started_at)}>${fmtTime(r.started_at)}</td>
                  <td>${r.env}</td>
                  <td class="served">${served(r.app_versions)}</td>
                  <td class="num">
                    ${r.steps}${
                      r.failed_steps
                        ? html`<div class="badc">${r.failed_steps} failed</div>`
                        : nothing
                    }
                  </td>
                  <td class="num">${dur(runMs(r))}</td>
                  <td class="sum">${compactChecks(r.summary)}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>`
    : html`<div class="empty">No runs.</div>`;
