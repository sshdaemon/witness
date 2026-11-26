const app = document.querySelector('#app');
const live = document.querySelector('#live');
const lightbox = document.querySelector('#lightbox');
const lightboxImg = document.querySelector('#lightbox-img');

const filters = { topic: null, env: '', verdict: '' };
let lastKey = '';
let routeSeq = 0;

const esc = v =>
  String(v ?? '').replaceAll(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const ICON = { PASS: '✓', FAIL: '✕', BLOCKED: '!', ABORTED: '–', RUNNING: '…', NOT_RUN: '○' };
const WORD = { NOT_RUN: 'NOT RUN' };

const badge = verdict => {
  const v = verdict || 'RUNNING';
  return `<span class="badge v-${esc(v)}"><span aria-hidden="true">${ICON[v] ?? ''}</span>${esc(WORD[v] ?? v)}</span>`;
};

const ticketHref = ticket => `#/ticket/${encodeURIComponent(ticket)}`;
const caseHref = (ticket, caseId) => `${ticketHref(ticket)}/case/${encodeURIComponent(caseId)}`;
const runName = r =>
  r.label || ((r.run_number ?? r.runNumber) ? `run ${r.run_number ?? r.runNumber}` : '');
// A check as one line: where it looked, what it wanted and, when it failed, what it found.
const checkLine = c => {
  const want = c.want === undefined ? '' : ` ${JSON.stringify(c.want)}`;
  const got = c.ok ? '' : ` <span class="badc">found ${esc(JSON.stringify(c.got))}</span>`;
  return `<li class="${c.ok ? 'ok' : 'bad'}"><span aria-hidden="true">${c.ok ? '✓' : '✕'}</span> <span class="mono">${esc(c.path)}</span> ${esc(c.check)}${esc(want)}${got} <span class="muted">step ${esc(c.seq)}</span></li>`;
};
const checkList = checks =>
  checks.length > 0
    ? `<ul class="checks">${checks
        .toSorted((a, b) => Number(a.ok) - Number(b.ok))
        .map(checkLine)
        .join('')}</ul>`
    : '';
// Who decided the result: the checks alone, or the session, which may have overruled them.
const judged = r => {
  if (r.judgedBy === 'checks') return '<span class="chip">by checks</span>';
  if (r.checksResult && r.checksResult !== r.result)
    return `<span class="chip warn" title="The checks gave ${esc(r.checksResult)}">overrode checks (${esc(WORD[r.checksResult] ?? r.checksResult)})</span>`;
  return '';
};

const fmtTime = iso =>
  iso
    ? new Date(iso).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '';
const ago = iso => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
};
const dur = ms => {
  if (ms == null) return '';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
};
const buildLabel = b =>
  b
    ? `${b.branch ? b.branch.replace(/^(feat|fix|feature)\//, '') : 'detached'}@${b.sha}${b.dirty ? ' +local' : ''}`
    : '';
const runMs = r => (r.finished_at ? new Date(r.finished_at) - new Date(r.started_at) : null);

async function get(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

// A slower, older request must never replace the page the person has since navigated to.
function render(key, html, seq) {
  // unchanged data: keep the page, and what the person has expanded, as it is
  if (seq !== routeSeq || key === lastKey) return;
  lastKey = key;
  app.innerHTML = html;
}

async function overview(seq) {
  const q = new URLSearchParams(
    Object.entries({ env: filters.env, verdict: filters.verdict }).filter(([, v]) => v),
  );
  if (filters.topic !== null) q.set('topic', filters.topic);
  const [tickets, topics, runs] = await Promise.all([
    get('/api/tickets'),
    get('/api/topics'),
    get(`/api/runs?${q}`),
  ]);
  const order = ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'];
  const ticketItem = t => `<li><a class="topic" href="${esc(ticketHref(t.ticket))}">
      <span class="t">${esc(t.ticket)}</span>
      <span class="counts">${order
        .filter(v => t.counts[v])
        .map(v => `<span class="count v-${v}">${ICON[v]} ${t.counts[v]}</span>`)
        .join('')}</span>
      <span class="when muted">${t.cases} case${t.cases === 1 ? '' : 's'} · ${t.runs} run${t.runs === 1 ? '' : 's'} · ${esc(ago(t.latest))}</span>
    </a></li>`;

  const topic = t => {
    const strip = t.recent
      .toReversed()
      .map(
        r =>
          `<i class="v-${esc(r.verdict || 'RUNNING')}" title="${esc(r.verdict || 'RUNNING')} · ${esc(fmtTime(r.started_at))}"></i>`,
      )
      .join('');
    return `<li><button class="topic${filters.topic === t.key ? ' selected' : ''}" data-action="pick-topic" data-key="${esc(t.key)}" aria-pressed="${filters.topic === t.key}">
      <span class="t">${esc(t.title)}</span>
      <span class="branch mono">${esc(t.branch || '')}</span>
      <span class="strip" aria-label="Last ${t.recent.length} runs, oldest first">${strip}</span>
      ${badge(t.latest.verdict)}
      <span class="when muted">${t.runs} run${t.runs === 1 ? '' : 's'} · ${esc(ago(t.latest.started_at))}</span>
    </button></li>`;
  };

  const selected = filters.topic === null ? null : topics.find(t => t.key === filters.topic);
  const toolSelected = !!selected?.tool;
  // One line: the build serving the API (what is under test), with the other apps behind a "+N
  // more" hover.
  const served = r => {
    const entries = Object.entries(r.app_versions ?? {}).filter(
      ([, b]) => b && typeof b === 'object',
    );
    if (entries.length === 0) return '';
    const main = entries.find(([name]) => name === 'api') ?? entries[0];
    const others = entries.filter(e => e !== main);
    const same = others
      .filter(([, b]) => buildLabel(b) === buildLabel(main[1]))
      .map(([name]) => name);
    const different = others.filter(([, b]) => buildLabel(b) !== buildLabel(main[1]));
    const all = entries.map(([name, b]) => `${name}: ${buildLabel(b)}`).join('\n');
    const more =
      different.length > 0
        ? ` <span class="chip" title="${esc(different.map(([name, b]) => `${name}: ${buildLabel(b)}`).join('\n'))}">+${different.length} other</span>`
        : '';
    const who = main[0] === 'api' ? '' : `<span class="muted">${esc(main[0])}</span> `;
    return `${who}<span class="mono" title="${esc(all)}">${esc(buildLabel(main[1]))}</span>${same.length > 0 ? ` <span class="muted">+${same.length} same</span>` : ''}${more}`;
  };
  const rows = runs
    .map(
      r => `<tr data-action="open-run" data-id="${esc(r.id)}" tabindex="0">
      <td class="num" title="${esc(fmtTime(r.started_at))}">${esc(fmtTime(r.started_at))}<div class="muted">${esc(ago(r.started_at))}</div></td>
      ${filters.topic === null ? `<td>${esc(r.topic || 'Untitled')}</td>` : ''}
      <td>${r.ticket ? `<a href="${esc(ticketHref(r.ticket))}">${esc(runName(r) || r.ticket)}</a>` : esc(r.label || '') || '<span class="muted">–</span>'}</td>
      <td>${badge(r.verdict)}</td>
      <td>${esc(r.env)}</td>
      <td class="mono">${esc(r.branch || '') || '<span class="muted">–</span>'}</td>
      <td class="served">${served(r) || '<span class="muted">–</span>'}</td>
      <td class="num">${r.steps}${r.failed_steps ? `<div class="muted">${r.failed_steps} failed</div>` : ''}</td>
      <td class="num">${esc(dur(runMs(r)))}</td>
      <td class="sum">${r.summary ? compactChecks(r.summary) : '<span class="muted">–</span>'}</td>
    </tr>`,
    )
    .join('');

  const opt = (value, label, current) =>
    `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
  render(
    JSON.stringify([tickets, topics, runs, filters]),
    `
    <h1>What we are testing</h1>
    ${
      tickets.length > 0
        ? `<h2>Tickets</h2><p class="note">The latest result of each case of the ticket.</p><ul class="topics">${tickets.map(ticketItem).join('')}</ul>`
        : ''
    }
    <h2>Topics</h2>
    ${
      topics.some(t => !t.tool)
        ? `<ul class="topics">${topics
            .filter(t => !t.tool)
            .map(topic)
            .join('')}</ul>`
        : `<div class="empty">Nothing tested yet. A session starts a topic with session_start.</div>`
    }
    ${
      topics.some(t => t.tool)
        ? `<details class="tooling"${toolSelected ? ' open' : ''}><summary>Tool development and checks (${topics.filter(t => t.tool).length})</summary><ul class="topics">${topics
            .filter(t => t.tool)
            .map(topic)
            .join('')}</ul></details>`
        : ''
    }
    <h2>Runs${selected ? ` · ${esc(selected.title)}` : ''}</h2>
    <div class="filters">
      ${filters.topic !== null ? `<button class="btn" data-action="all-topics">Show runs of all topics</button>` : ''}
      <select data-filter="env" aria-label="Environment"><option value="">All environments</option>${opt('local', 'local', filters.env)}${opt('staging', 'staging', filters.env)}</select>
      <select data-filter="verdict" aria-label="Verdict"><option value="">All verdicts</option>${['PASS', 'FAIL', 'BLOCKED', 'ABORTED'].map(v => opt(v, v, filters.verdict)).join('')}</select>
      ${filters.env || filters.verdict ? `<button class="btn" data-action="clear-filters">Clear filters</button>` : ''}
    </div>
    ${rows ? `<div class="table-wrap"><table><thead><tr><th>Started</th>${filters.topic === null ? '<th>Topic</th>' : ''}<th>Run</th><th>Result</th><th>Env</th><th>Branch tested</th><th>Served from</th><th>Steps</th><th>Duration</th><th>What was checked</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">No runs match.</div>`}
  `,
    seq,
  );
}

// "ok: x; FAIL: y | note" is a checklist; free text stays a plain line. One splitter for the row
// and the full list.
const splitSummary = text =>
  text
    .replaceAll(/^[\s|;]+|[\s|;]+$/g, '')
    .split(/;\s+|\s+\|\s+/)
    .map(l => l.trim())
    .filter(Boolean);

const summaryLines = text =>
  `<ul class="checks">${splitSummary(text)
    .map(line => {
      const m = /^(ok|FAIL):\s*(.*)$/.exec(line);
      if (!m) return `<li class="plain">${esc(line)}</li>`;
      return m[1] === 'ok'
        ? `<li class="ok"><span aria-hidden="true">✓</span> ${esc(m[2])}</li>`
        : `<li class="bad"><span aria-hidden="true">✕</span> ${esc(m[2])}</li>`;
    })
    .join('')}</ul>`;

// In a table row: a count, any failed check in full, notes clamped, and the whole list behind a
// click.
function compactChecks(text) {
  const lines = splitSummary(text);
  if (lines.length === 0) return '<span class="muted">–</span>';
  const ok = lines.filter(l => l.startsWith('ok:')).length;
  const bad = lines.filter(l => l.startsWith('FAIL:'));
  const notes = lines.filter(l => !/^(ok|FAIL):/.test(l));
  if (!ok && bad.length === 0)
    return `<div class="clamp" title="${esc(lines.join('; '))}">${esc(lines.join('; '))}</div>`;
  const head = [
    ok ? `<span class="okc">✓ ${ok} passed</span>` : '',
    bad.length > 0 ? `<span class="badc">✕ ${bad.length} failed</span>` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const failed = bad
    .map(l => `<div class="badc">${esc(l.replace(/^FAIL:\s*/, ''))}</div>`)
    .join('');
  const note =
    notes.length > 0
      ? `<div class="clamp muted" title="${esc(notes.join('; '))}">${esc(notes.join('; '))}</div>`
      : '';
  return `<details class="rowchecks"><summary>${head}</summary>${summaryLines(text)}</details>${failed}${note}`;
}

// A step can carry several frames, in the order they were taken; older runs have only the one.
const shots = s => {
  let list = [];
  if (s.screenshots?.length) list = s.screenshots;
  else if (s.screenshot) list = [s.screenshot];
  return list.length > 0
    ? `<div class="thumbs">${list.map((src, i) => `<img class="thumb" loading="lazy" src="${esc(src)}" data-action="zoom" data-src="${esc(src)}" alt="Screenshot ${i + 1} of ${list.length} after ${esc(s.tool)}" />`).join('')}</div>`
    : '';
};

const shortArgs = args => {
  const entries = Object.entries(args ?? {}).filter(([, v]) => v !== undefined);
  return entries
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(', ');
};
const pretty = v => esc(JSON.stringify(v, null, 2));

async function runPage(id, seq) {
  const d = await get(`/api/runs/${encodeURIComponent(id)}`);
  const r = d.run;
  const ms = runMs(r);

  const cases = d.cases ?? [];
  const startsAt = new Map(cases.filter(c => c.steps).map(c => [c.steps.from, c]));
  const inCase = step => cases.some(c => c.steps && c.steps.from <= step && step <= c.steps.to);
  const caseRows = cases
    .map(
      c => `<tr>
      <td><a href="${esc(caseHref(c.ticket, c.caseId))}">${esc(c.caseId)}</a></td>
      <td>${badge(c.result)} ${judged(c)}</td>
      <td class="num">${c.steps ? `${c.steps.from}–${c.steps.to}` : '<span class="muted">–</span>'}</td>
      <td>${esc(c.actual || '')}${c.note ? `<div class="muted">${esc(c.note)}</div>` : ''}${c.checks.some(k => !k.ok) ? checkList(c.checks.filter(k => !k.ok)) : ''}</td>
    </tr>`,
    )
    .join('');
  const steps = d.steps
    .map(s => {
      const opens = startsAt.get(s.seq);
      // Steps after a case and before the next one (shared setup, cleanup) belong to no case.
      const leaves =
        !opens && cases.some(c => c.steps && c.steps.to === s.seq - 1) && !inCase(s.seq);
      let header = '';
      if (opens)
        header = `<li class="case-head" id="case-${esc(opens.caseId)}"><a href="${esc(caseHref(opens.ticket, opens.caseId))}">${esc(opens.caseId)}</a> ${badge(opens.result)} <span class="muted">steps ${opens.steps.from}–${opens.steps.to}</span></li>`;
      else if (leaves) header = '<li class="case-head muted">Outside cases</li>';
      const obs = s.observation ?? {};
      const err = !s.ok
        ? `<div class="err"><strong>${esc(s.errorCode || obs.code || 'error')}</strong> ${esc(obs.message || '')}${obs.hint ? ` <span class="hint">— ${esc(obs.hint)}</span>` : ''}</div>`
        : '';
      return `${header}<li class="step${s.ok ? '' : ' bad'}">
      <div class="row">
        <span class="seq">${s.seq}</span>
        <span class="tool">${esc(s.tool)}</span>
        <span class="args" title="${esc(shortArgs(s.args))}">${esc(shortArgs(s.args))}</span>
        <span class="spacer"></span>
        ${s.pageKind ? `<span class="chip">${esc(s.pageKind)}</span>` : ''}
        <span class="muted mono">${esc(dur(s.durationMs))}</span>
        ${s.ok ? '' : badge('FAIL')}
      </div>
      ${err}
      ${shots(s)}
      <details><summary>Details</summary><pre>${pretty({ args: s.args, result: obs.data ?? obs })}</pre></details>
    </li>`;
    })
    .join('');

  const evidence = d.artifacts
    .filter(a => a.kind !== 'screenshot')
    .map(
      a => `<div class="ev">
      <span class="chip">${esc(a.kind)}</span>
      <code>${esc(a.openWith)}</code>
      <button class="btn" data-action="copy" data-text="${esc(a.openWith)}">Copy</button>
    </div>`,
    )
    .join('');

  const failed = d.steps.filter(s => !s.ok).length;
  render(
    JSON.stringify(d),
    `
    <p class="crumbs"><a href="#/">← Back to topics and runs</a></p>
    <div class="head"><h1>${esc(r.topic || 'Untitled run')}</h1>${badge(r.verdict)}</div>
    <div class="meta">
      ${r.ticket ? `<span><a href="${esc(ticketHref(r.ticket))}">${esc(r.ticket)}</a>${r.run_number ? ` run ${esc(r.run_number)}` : ''}</span>` : ''}
      ${r.label && !r.ticket ? `<span>${esc(r.label)}</span>` : ''}
      ${(d.lanes ?? []).length > 1 ? `<span>lane ${esc(r.lane)} of ${d.lanes.length}: ${d.lanes.map(l => (l.id === r.id ? `<strong>${esc(l.lane)}</strong>` : `<a href="#/run/${esc(l.id)}">${esc(l.lane)}</a>`)).join(' ')}</span>` : ''}
      <span>${esc(r.env)}</span>
      ${r.branch ? `<span>testing <span class="mono">${esc(r.branch)}</span></span>` : ''}
      ${Object.entries(r.app_versions ?? {})
        .map(
          ([name, b]) =>
            `<span>${esc(name)} <span class="mono">${esc(buildLabel(b))}</span></span>`,
        )
        .join('')}
      <span>run tag <span class="mono">${esc(r.run_tag)}</span></span>
      <span title="${esc(r.started_at)}">${esc(fmtTime(r.started_at))}</span>
      ${ms != null ? `<span>${esc(dur(ms))}</span>` : `<span>still running</span>`}
      <span>${d.steps.length} steps${failed ? `, ${failed} failed` : ''}</span>
      <span class="mono">${esc(r.id)}</span>
    </div>
    ${r.summary ? `<div class="summary v-${esc(r.verdict || 'RUNNING')}">${summaryLines(r.summary)}</div>` : ''}
    ${caseRows ? `<h2>Cases</h2><div class="table-wrap"><table><thead><tr><th>Case</th><th>Result</th><th>Steps</th><th>What it showed</th></tr></thead><tbody>${caseRows}</tbody></table></div>` : ''}
    <h2>Steps</h2>
    <p class="note">Yellow on a screenshot marks what the step changed, checked, configured or searched.</p>
    ${steps ? `<ol class="steps">${steps}</ol>` : `<div class="empty">No steps recorded.</div>`}
    <h2>Evidence on disk</h2>
    <div class="evidence">${evidence || `<div class="empty">No traces or logs recorded.</div>`}</div>
    <p class="note">Traces and logs can contain cookies and tokens, so this page never serves them. Open a trace with the command above.</p>
  `,
    seq,
  );
}

async function ticketPage(ticket, seq) {
  const d = await get(`/api/tickets/${encodeURIComponent(ticket)}`);
  const head = r => {
    const name = r.runNumber ? `run ${r.runNumber}` : 'run';
    // A batch's lanes ran at once; each opens on its own.
    const lanes =
      r.lanes.length > 1
        ? `<div class="lanes">${r.lanes.map(l => (l.pruned ? `<span class="muted">lane ${esc(l.lane ?? '?')}</span>` : `<a href="#/run/${esc(l.id)}" title="${esc(l.verdict || 'still open')}">lane ${esc(l.lane ?? '?')}</a>`)).join(' ')}</div>`
        : '';
    const title = r.pruned
      ? 'Removed by retention: its steps and screenshots are gone, its case results are kept.'
      : `${r.label || ''} · ${r.env || ''} · ${fmtTime(r.startedAt)}`;
    const link =
      r.pruned || r.lanes.length > 1
        ? `<span${r.pruned ? ' class="muted"' : ''}>${esc(name)}</span>`
        : `<a href="#/run/${esc(r.lanes[0].id)}">${esc(name)}</a>`;
    return `<th class="runcol" title="${esc(title)}">${link}<div>${r.pruned ? '<span class="chip">removed</span>' : badge(r.verdict)}</div>${lanes}</th>`;
  };
  const cell = (c, r) => {
    const x = c.cells[r.id];
    if (!x) return '<td class="cell"></td>';
    return `<td class="cell"><a class="dot v-${esc(x.result)}" href="${esc(caseHref(d.ticket, c.caseId))}" title="${esc(c.caseId)} ${esc(WORD[x.result] ?? x.result)} in ${esc(r.label || r.id)}">${ICON[x.result] ?? '?'}</a></td>`;
  };
  const current = c => {
    const x = c.current;
    if (!x) return '<td class="muted">never run</td>';
    return `<td>${badge(x.result)} <span class="muted">run ${esc(x.runNumber ?? '?')}</span>${
      x.olderBuild
        ? ` <span class="chip warn" title="${esc(
            Object.entries(x.build ?? {})
              .map(([n, b]) => `${n}: ${buildLabel(b)}`)
              .join('\n'),
          )}">older build</span>`
        : ''
    }${c.evidence ? ` <span class="chip">${c.evidence} shot${c.evidence === 1 ? '' : 's'}</span>` : ''}${judged(x)}</td>`;
  };
  const rows = d.cases
    .map(
      c => `<tr>
      <td><a href="${esc(caseHref(d.ticket, c.caseId))}">${esc(c.caseId)}</a>${c.title ? `<div class="muted">${esc(c.title)}</div>` : ''}</td>
      ${current(c)}
      ${d.runs.map(r => cell(c, r)).join('')}
    </tr>`,
    )
    .join('');
  const order = ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'];
  const counts = order
    .map(v => [v, d.cases.filter(c => c.current?.result === v).length])
    .filter(([, n]) => n)
    .map(
      ([v, n]) =>
        `<span class="count v-${v}">${ICON[v]} ${n} ${esc((WORD[v] ?? v).toLowerCase())}</span>`,
    )
    .join('');
  const older = d.cases.filter(c => c.current?.olderBuild).length;
  render(
    JSON.stringify(['ticket', d]),
    `
    <p class="crumbs"><a href="#/">← Back to tickets and runs</a></p>
    <div class="head"><h1>${esc(d.ticket)}</h1></div>
    <div class="meta"><span>${d.cases.length} case${d.cases.length === 1 ? '' : 's'}</span><span>${d.runs.length} run${d.runs.length === 1 ? '' : 's'}</span><span class="counts">${counts}</span>${older ? `<span class="chip warn">${older} on an older build than run ${esc(d.runs.at(-1)?.runNumber ?? '')}</span>` : ''}</div>
    <h2>Cases by run</h2>
    <p class="note">Current is each case's latest result. Older build means it last ran on other builds than the newest run.</p>
    ${rows ? `<div class="table-wrap"><table class="grid"><thead><tr><th>Case</th><th>Current</th>${d.runs.map(head).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">No case results yet. case_begin and case_end record them.</div>'}
  `,
    seq,
  );
}

const thumbList = list =>
  `<div class="thumbs">${list.map(s => `<img class="thumb" loading="lazy" src="${esc(s.url)}" data-action="zoom" data-src="${esc(s.url)}" alt="Screenshot of step ${esc(s.step)}" />`).join('')}</div>`;
// What the case checked first; the frames taken on the way stay folded.
const caseShots = screenshots => {
  const checked = screenshots.filter(s => !s.frame);
  const frames = screenshots.filter(s => s.frame);
  return `${checked.length > 0 ? thumbList(checked) : ''}${frames.length > 0 ? `<details><summary>${frames.length} frame${frames.length === 1 ? '' : 's'} taken on the way</summary>${thumbList(frames)}</details>` : ''}`;
};

async function casePage(ticket, caseId, seq) {
  const d = await get(
    `/api/tickets/${encodeURIComponent(ticket)}/cases/${encodeURIComponent(caseId)}`,
  );
  const def = d.definition;
  const list = v =>
    Array.isArray(v) && v.length > 0
      ? v.map(x => esc(typeof x === 'string' ? x : JSON.stringify(x))).join(', ')
      : '';
  const commands = Array.isArray(def?.block)
    ? `<details><summary>Commands (${def.block.length})</summary><pre>${pretty(def.block)}</pre></details>`
    : '';
  const run = h => {
    const where = h.run
      ? `<a href="#/run/${esc(h.runId)}">${esc(h.run.label || h.runId)}</a> · ${esc(h.run.env || '')} · ${esc(fmtTime(h.run.started_at))}`
      : `run ${esc(h.runNumber ?? '?')} <span class="chip">removed</span>`;
    return `<li class="step">
      <div class="row">${badge(h.result)} ${judged(h)}${h.earlierVersion ? '<span class="chip" title="The case has changed in its case file since this run">earlier version</span>' : ''}<span>${where}</span><span class="spacer"></span>${h.steps ? `<span class="muted">steps ${h.steps.from}–${h.steps.to}</span>` : ''}</div>
      ${h.actual ? `<div>${esc(h.actual)}</div>` : ''}
      ${h.note ? `<div class="muted">${esc(h.note)}</div>` : ''}
      ${checkList(h.checks)}
      ${caseShots(h.screenshots)}
      <div class="muted mono">${esc(
        Object.entries(h.app_versions ?? {})
          .map(([n, b]) => `${n} ${buildLabel(b)}`)
          .join(' · '),
      )}</div>
    </li>`;
  };
  const figures = d.evidence
    .map(
      e => `<figure class="evidence">
      <img class="thumb" loading="lazy" src="${esc(e.url)}" data-action="zoom" data-src="${esc(e.url)}" alt="${esc(e.caption)}" />
      <figcaption>${esc(e.caption)}<div class="muted"><a href="#/run/${esc(e.runId)}">step ${esc(e.step)}</a> · ${e.postedUrl ? 'posted' : 'not posted'}</div></figcaption>
    </figure>`,
    )
    .join('');
  render(
    JSON.stringify(['case', d]),
    `
    <p class="crumbs"><a href="${esc(ticketHref(d.ticket))}">← Back to ${esc(d.ticket)}</a></p>
    <div class="head"><h1>${esc(d.caseId)}${def?.title ? ` · ${esc(def.title)}` : ''}</h1>${d.history.length > 0 ? badge(d.history.at(-1).result) : ''}</div>
    ${
      def
        ? `<div class="summary">
        ${Array.isArray(def.steps) && def.steps.length > 0 ? `<strong>Steps</strong><ol>${def.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
        ${def.expected ? `<strong>Expected result</strong><p>${esc(def.expected)}</p>` : ''}
        ${list(def.needs) ? `<div class="muted">Needs ${list(def.needs)}</div>` : ''}
        ${list(def.after) ? `<div class="muted">Runs after ${list(def.after)}</div>` : ''}
        ${commands}
      </div>`
        : '<p class="note">No case definition stored yet: results only.</p>'
    }
    <h2>Runs</h2>
    ${d.history.length > 0 ? `<ol class="steps">${d.history.toReversed().map(run).join('')}</ol>` : '<div class="empty">Not run yet.</div>'}
    ${figures ? `<h2>Evidence</h2><div class="evidence-grid">${figures}</div>` : ''}
  `,
    seq,
  );
}

async function evidencePage(seq) {
  const tickets = await get('/api/evidence');
  const item = e => `<figure class="evidence">
      <img class="thumb" loading="lazy" src="${esc(e.url)}" data-action="zoom" data-src="${esc(e.url)}" alt="${esc(e.caption)}" />
      <figcaption>
        ${e.case ? `<span class="chip">${esc(e.case)}</span> ` : ''}${esc(e.caption)}
        <div class="muted">
          <a href="#/run/${esc(e.runId)}">run ${esc(e.runId)}</a>, step ${esc(e.step)} ${esc(e.tool || '')}
          · ${e.postedUrl ? `<a href="${esc(e.postedUrl)}" rel="noreferrer" target="_blank">posted</a>` : 'not posted'}
          · <button class="btn small" data-action="copy" data-text="${esc(e.file)}">Copy</button> path
        </div>
      </figcaption>
    </figure>`;
  render(
    JSON.stringify(['evidence', tickets]),
    `
    <p class="crumbs"><a href="#/">← Back to topics and runs</a></p>
    <h1>Evidence</h1>
    <p class="sub">Screenshots picked for tickets with evidence_pick. They are copies, kept after their runs are removed.</p>
    ${
      tickets.length > 0
        ? tickets
            .map(
              t => `<h2>${esc(t.ticket)} <span class="muted">· ${t.items.length} screenshot${t.items.length === 1 ? '' : 's'}, ${t.items.filter(e => e.postedUrl).length} posted</span></h2>
              <div class="evidence-grid">${t.items.map(item).join('')}</div>`,
            )
            .join('')
        : '<div class="empty">No evidence yet. evidence_pick keeps a step\'s screenshot for a ticket.</div>'
    }`,
    seq,
  );
}

async function route() {
  const seq = ++routeSeq;
  const hash = location.hash.replace(/^#\/?/, '');
  const run = /^run\/([0-9a-z-]+)$/.exec(hash);
  const topic = /^topic\/(.*)$/.exec(hash);
  const ticket = /^ticket\/([^/]+)(?:\/case\/([^/]+))?$/.exec(hash);
  try {
    filters.topic = topic ? decodeURIComponent(topic[1]) : null;
  } catch {
    filters.topic = null; // a hand-edited or truncated link
  }
  try {
    if (run) await runPage(run[1], seq);
    else if (ticket && ticket[2])
      await casePage(decodeURIComponent(ticket[1]), decodeURIComponent(ticket[2]), seq);
    else if (ticket) await ticketPage(decodeURIComponent(ticket[1]), seq);
    else if (hash === 'evidence') await evidencePage(seq);
    else await overview(seq);
    live.classList.remove('paused');
  } catch (e) {
    live.classList.add('paused');
    render(
      `error:${e.message}`,
      `<div class="empty">Could not load results: ${esc(e.message)}</div>`,
      seq,
    );
  }
}

document.addEventListener('click', e => {
  if (e.target.closest('details.rowchecks')) return; // opening the full list must not open the run
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id, src, text } = el.dataset;
  if (action === 'open-run') location.hash = `#/run/${id}`;
  if (action === 'pick-topic')
    location.hash =
      filters.topic === el.dataset.key ? '#/' : `#/topic/${encodeURIComponent(el.dataset.key)}`;
  if (action === 'all-topics') location.hash = '#/';
  if (action === 'clear-filters') {
    Object.assign(filters, { env: '', verdict: '' });
    lastKey = '';
    route();
  }
  if (action === 'zoom') {
    lightboxImg.src = src;
    lightbox.hidden = false;
  }
  if (action === 'copy') {
    navigator.clipboard?.writeText(text);
    el.textContent = 'Copied';
    setTimeout(() => (el.textContent = 'Copy'), 1200);
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') lightbox.hidden = true;
  if (e.target.closest?.('details.rowchecks')) return;
  const row = e.target.closest?.("tr[data-action='open-run']");
  if (row && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    location.hash = `#/run/${row.dataset.id}`;
  }
});
document.addEventListener('change', e => {
  const f = e.target.dataset?.filter;
  if (f) {
    filters[f] = e.target.value;
    lastKey = '';
    route();
  }
});
lightbox.addEventListener('click', () => (lightbox.hidden = true));
window.addEventListener('hashchange', () => {
  lastKey = '';
  route();
  window.scrollTo(0, 0);
});

route();
setInterval(() => !document.hidden && route(), 5000);
