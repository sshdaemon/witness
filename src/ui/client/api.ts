// What the viewer's read API answers, as far as the pages use it. See docs/read-contract.md.

export type Verdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'ABORTED' | 'NOT_RUN';
export type Build = { branch?: string | null; sha: string; dirty?: boolean };
export type Builds = Record<string, Build | unknown>;

export type Check = {
  seq: number;
  path: string;
  check: string;
  want?: unknown;
  got?: unknown;
  ok: boolean;
};

export type CaseResult = {
  runId: string;
  runNumber: number | null;
  result: Verdict;
  actual: string | null;
  note: string | null;
  steps: { from: number; to: number } | null;
  judgedBy: string;
  checksResult: string | null;
  checks: Check[];
  finishedAt: string;
};

export type Ticket = {
  ticket: string | null;
  runs: number;
  cases: number;
  counts: Partial<Record<Verdict, number>>;
  latest: string;
  verdict: Verdict | null;
  tool: boolean;
};

export type RunRow = {
  id: string;
  ticket: string | null;
  run_number: number | null;
  label: string | null;
  env: string;
  branch: string | null;
  kind: string | null;
  run_tag: string;
  started_at: string;
  finished_at: string | null;
  verdict: Verdict | null;
  summary: string | null;
  app_versions: Builds | null;
  steps: number;
  failed_steps: number;
};

export type Lane = { id: string; lane: number | null; verdict: Verdict | null; pruned: boolean };

export type TicketDetail = {
  ticket: string;
  runs: {
    id: string;
    runNumber: number | null;
    label: string | null;
    startedAt: string | null;
    verdict: Verdict | null;
    env: string | null;
    pruned: boolean;
    lanes: Lane[];
  }[];
  cases: {
    caseId: string;
    title: string | null;
    cells: Record<string, { result: Verdict; judgedBy: string }>;
    current: (CaseResult & { build: Builds | null; olderBuild: boolean }) | null;
    evidence: number;
  }[];
};

export type CaseRun = CaseResult & {
  run: { id: string; label: string | null; env: string | null; started_at: string } | null;
  earlierVersion: boolean;
  app_versions: Builds | null;
  screenshots: { step: number; url: string; frame: boolean }[];
};

export type Picked = {
  id: number;
  caption: string;
  runId: string;
  step: number;
  postedUrl: string | null;
  url: string;
};

export type CaseDetail = {
  ticket: string;
  caseId: string;
  definition: {
    title: string | null;
    steps: string[] | null;
    expected: string | null;
    needs: unknown[] | null;
    after: unknown[] | null;
    block: unknown[] | null;
  } | null;
  history: CaseRun[];
  evidence: Picked[];
};

export type Step = {
  seq: number;
  tool: string;
  args: Record<string, unknown> | null;
  ok: boolean;
  errorCode: string | null;
  pageKind: string | null;
  url: string | null;
  durationMs: number | null;
  observation: {
    code?: string;
    message?: string;
    hint?: string;
    data?: unknown;
  } | null;
  screenshot: string | null;
  screenshots: string[];
};

export type RunDetail = {
  run: RunRow & {
    kind: string | null;
    batch_id: string | null;
    lane: number | null;
  };
  steps: Step[];
  artifacts: {
    stepSeq: number | null;
    kind: string;
    name: string;
    bytes: number | null;
    openWith: string;
    url: string | null;
  }[];
  cases: (CaseResult & { ticket: string; caseId: string })[];
  lanes: { id: string; lane: number | null; verdict: Verdict | null }[];
};

export type EvidenceTicket = {
  ticket: string;
  latest: string;
  items: (Picked & { case: string | null; tool: string | null; file: string })[];
};

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  tickets: () => get<Ticket[]>('/api/tickets'),
  ticket: (ticket: string) => get<TicketDetail>(`/api/tickets/${encodeURIComponent(ticket)}`),
  caseOf: (ticket: string, caseId: string) =>
    get<CaseDetail>(
      `/api/tickets/${encodeURIComponent(ticket)}/cases/${encodeURIComponent(caseId)}`,
    ),
  runs: (ticket: string) =>
    get<RunRow[]>(`/api/runs?ticket=${encodeURIComponent(ticket)}&limit=200`),
  run: (id: string) => get<RunDetail>(`/api/runs/${encodeURIComponent(id)}`),
  evidence: () => get<EvidenceTicket[]>('/api/evidence'),
};
