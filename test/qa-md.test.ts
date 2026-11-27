import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readSection, renderCases, renderRuns, replaceSection } from '../src/ledger/qaMd.js';
import type { LedgerResult, LedgerRun } from '../src/ledger/qaMd.js';
import { caseHash, parseCaseFile } from '../src/runner/caseFile.js';

await import('./helpers/app.js');

const file = parseCaseFile({
  ticket: 'AB-9',
  fixtures: { product: [['product_create', { name: 'x' }, { as: 'product' }]] },
  cases: {
    C10: {
      title: 'Stock | lowered',
      actor: 'staff',
      kind: 'edge',
      needs: ['product'],
      after: ['C2'],
      block: [
        ['product_stock', {}],
        ['sleep', { seconds: 1 }],
      ],
    },
    C2: {
      title: 'Stock left',
      actor: 'buyer',
      kind: 'happy',
      steps: ['Order one mug', 'Open the stock page'],
      expected: 'The product shows 1 left.',
      block: [
        ['order_create', {}],
        ['product_stock', {}],
      ],
    },
    C3: { title: 'Never run', block: [['where_am_i', {}]] },
  },
});
const hash2 = caseHash(file.cases.C2!, file.fixtures);
const result = (r: Partial<LedgerResult>): LedgerResult => ({
  run_id: 'r',
  case_id: 'C2',
  run_number: 1,
  env: 'local',
  result: 'PASS',
  actual: null,
  note: null,
  case_hash: null,
  finished_at: '2026-11-01T10:00:00Z',
  ...r,
});
const results = [
  result({ run_id: 'r1', run_number: 1, env: 'staging', case_hash: hash2, actual: '1 left' }),
  result({
    run_id: 'r2',
    run_number: 2,
    result: 'FAIL',
    case_hash: 'old',
    finished_at: '2026-11-02T10:00:00Z',
    actual: 'found 2 | 2',
  }),
  result({
    run_id: 'r2',
    run_number: 2,
    case_id: 'C10',
    result: 'NOT_RUN',
    note: 'runs after C2, which was blocked',
    finished_at: '2026-11-02T10:01:00Z',
  }),
  // A result from before results kept their environment.
  result({ run_id: 'r4', run_number: 4, case_id: 'C3', env: null, case_hash: 'x' }),
];
const runs: LedgerRun[] = [
  { id: 'r2', run_number: 2, env: 'local', started_at: '2026-11-02T09:59:00Z', verdict: 'FAIL' },
];

describe('QA ledger sections', () => {
  it('tables each case with its tools and its latest result per environment', () => {
    const md = renderCases(file, results);
    const rows = md.split('\n').filter(l => l.startsWith('| C'));
    assert.deepEqual(rows, [
      '| C2 | Stock left | buyer | happy | `order_create`, `product_stock` | ' +
        'FAIL (local run 2, earlier version); PASS (staging run 1) |',
      '| C3 | Never run |  |  | `where_am_i` | PASS (run 4, earlier version) |',
      '| C10 | Stock \\| lowered | staff | edge | `product_create`, ' +
        '`product_stock` | NOT RUN (local run 2) |',
    ]);
    assert.match(
      md,
      new RegExp(
        [
          '### C2\\. Stock left',
          '',
          '\\*\\*Steps\\*\\*',
          '1\\. Order one mug',
          '2\\. Open the stock page',
          '',
          '\\*\\*Expected result\\*\\*',
          'The product shows 1 left\\.',
        ].join('\n'),
      ),
    );
    assert.match(md, /### C10\. Stock \| lowered\n\nNeeds product\. Runs after C2\./);
  });

  it('lists the runs in order, a removed one from its case results', () => {
    assert.equal(
      renderRuns(runs, results),
      [
        '- Run 1 (staging, 2026-11-01, r1): removed by retention. C2 PASS (1 left).',
        '- Run 2 (local, 2026-11-02, r2): FAIL. C2 FAIL (found 2 \\| 2); ' +
          'C10 NOT RUN (runs after C2, which was blocked).',
        '- Run 4 (2026-11-01, r4): removed by retention. C3 PASS.',
      ].join('\n'),
    );
    assert.equal(renderRuns([], []), '_No runs recorded yet._');
  });

  it('keeps the line written earlier for a run the store no longer has', () => {
    const before = [
      '- Run 1 (staging, 2026-11-01, 20261101100000-aaaaaa): PASS. C2 PASS (1 left).',
      '- Run 3 (local, 2026-11-03, 20261103100000-cccccc): BLOCKED. No cases recorded.',
    ].join('\n');
    const now = [
      result({ run_id: '20261101100000-aaaaaa', run_number: 1, env: 'staging' }),
      result({
        run_id: '20261105100000-eeeeee',
        run_number: 5,
        finished_at: '2026-11-05T10:00:00Z',
      }),
    ];
    const live: LedgerRun[] = [
      {
        id: '20261105100000-eeeeee',
        run_number: 5,
        env: 'local',
        started_at: '2026-11-05T09:00:00Z',
        verdict: 'PASS',
      },
    ];
    assert.equal(
      renderRuns(live, now, before),
      [
        '- Run 1 (staging, 2026-11-01, 20261101100000-aaaaaa): PASS. C2 PASS (1 left).',
        '- Run 3 (local, 2026-11-03, 20261103100000-cccccc): BLOCKED. No cases recorded.',
        '- Run 5 (local, 2026-11-05, 20261105100000-eeeeee): PASS. C2 PASS.',
      ].join('\n'),
    );
  });

  it('gives a case run by hand a row of its own', () => {
    const md = renderCases(file, [result({ case_id: 'C7', env: 'local', run_number: 3 })]);
    assert.ok(md.includes('| C7 | (not in the case file) |  |  |  | PASS (local run 3) |'));
    assert.ok(!md.includes('### C7'));
  });

  it('rewrites only what sits between the markers, the same way each time', () => {
    const ledger = [
      '# AB-9 — QA',
      '',
      '## Cases',
      'Hand-written intro.',
      '<!-- cases:start -->',
      'old table',
      '<!-- cases:end -->',
      '',
      '## Runs',
      '<!-- runs:start -->',
      '<!-- runs:end -->',
      '- A note by hand.',
    ].join('\n');
    const once = replaceSection(replaceSection(ledger, 'cases', 'NEW'), 'runs', 'RUNS');
    assert.equal(
      once,
      ledger
        .replace('old table', 'NEW')
        .replace('<!-- runs:start -->\n', '<!-- runs:start -->\nRUNS\n'),
    );
    assert.equal(replaceSection(replaceSection(once, 'cases', 'NEW'), 'runs', 'RUNS'), once);
    assert.throws(() => replaceSection('# no markers', 'cases', 'x'), /add both markers/);
    assert.equal(readSection(once, 'runs'), '\nRUNS\n');
    assert.equal(readSection('# none', 'runs'), '');
  });
});
