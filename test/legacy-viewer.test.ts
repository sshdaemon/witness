import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';

// A store from before topics, branches and kinds existed. The viewer reads it as it is and never
// migrates it.
const dir = mkdtempSync(join(tmpdir(), 'witness-legacy-viewer-'));
process.env.WITNESS_RESULTS_DIR = dir;
const old = new DatabaseSync(join(dir, 'witness.sqlite'));
old.exec(
  `
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, use_case_id TEXT, env TEXT NOT NULL, run_tag TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT, verdict TEXT, summary TEXT,
      first_failure_step INTEGER, trace_path TEXT, step_log_path TEXT, client TEXT
    )
  `,
);
old.exec(
  `
    CREATE TABLE steps (
      run_id TEXT NOT NULL, seq INTEGER NOT NULL, tool TEXT NOT NULL, args_json TEXT,
      ok INTEGER NOT NULL, error_code TEXT, page_kind TEXT, url TEXT, duration_ms INTEGER,
      observation_json TEXT, screenshot_path TEXT, PRIMARY KEY (run_id, seq)
    )
  `,
);
old.exec(
  `
    CREATE TABLE artifacts (
      run_id TEXT NOT NULL, step_seq INTEGER, kind TEXT NOT NULL, path TEXT NOT NULL, bytes INTEGER
    )
  `,
);
old.exec(
  `
    INSERT INTO runs (id, use_case_id, env, run_tag, started_at, verdict)
    VALUES ('r1', 'old-case-name', 'local', 'abc', '2025-01-01T00:00:00Z', 'PASS')
  `,
);
old.close();

const { createViewer } = await import('../src/ui/server.js');

describe('viewer over an older store', () => {
  let server: Server;
  let base: string;
  before(async () => {
    server = createViewer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it('lists no tickets', async () => {
    assert.deepEqual(await (await fetch(`${base}/api/tickets`)).json(), []);
    assert.equal((await fetch(`${base}/api/tickets/AB-1`)).status, 404);
  });

  it('groups, lists and opens runs that have only a use-case slug', async () => {
    const topics = (await (await fetch(`${base}/api/topics`)).json()) as {
      key: string;
      title: string;
      tool: boolean;
    }[];
    assert.deepEqual(
      topics.map(t => [t.key, t.title, t.tool]),
      [['old-case-name', 'Old case name', false]],
    );
    const runs = (await (await fetch(`${base}/api/runs?topic=old-case-name`)).json()) as {
      id: string;
      topic: string;
      branch: string | null;
    }[];
    assert.deepEqual(
      runs.map(r => [r.id, r.topic, r.branch]),
      [['r1', 'Old case name', null]],
    );
    const detail = (await (await fetch(`${base}/api/runs/r1`)).json()) as {
      run: { topic: string };
    };
    assert.equal(detail.run.topic, 'Old case name');
  });
});
