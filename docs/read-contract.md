# Reading the results

What a reader outside the engine (a QA checker, a script, another tool) may rely on when it reads runs, cases and steps. Read through the CLI below or the module behind it (`src/read`, exported as `witness/read`). The SQLite tables are not part of the contract: they change with migrations, and the read module keeps up with them.

## Where the results are

- Folder: `~/.witness/`, or `WITNESS_RESULTS_DIR` when set. `npm run -s read -- where` prints the folder and the database it uses.
- Database: `witness.sqlite` in that folder. Only the engine opens it; readers use the CLI.

## The read CLI

Run it in the app's checkout as `npm run -s read -- …` (the app's script runs `tsx node_modules/witness/src/read/cli.ts`), or with `npm --prefix <that folder>`. Each command prints JSON on stdout. Exit 0 means it printed an answer, 1 that the run, ticket or case is not there, and 2 a wrong command or argument (with the usage on stderr). It opens the database read-only.

| Command                                                 | Prints                                                                                                                                                                                                                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `where`                                                 | `{ resultsDir, database }`                                                                                                                                                                                              |
| `runs [--ticket t] [--env e] [--verdict v] [--limit n]` | runs, newest first: `id`, `ticket`, `run_number`, `label`, `env`, `branch`, `kind`, `started_at`, `finished_at`, `verdict`, `summary`, `app_versions`, `steps`, `failed_steps`                                          |
| `run <runId>`                                           | `{ run, cases, artifacts, lanes }` without the steps                                                                                                                                                                    |
| `steps <runId> [--from n] [--to m]`                     | the steps numbered n to m (all by default)                                                                                                                                                                              |
| `tickets`                                               | every ticket with its cases' latest results, its latest run's verdict (from that run's cases once retention removed the run) and whether only tools were checked; runs with no ticket come together under a null ticket |
| `ticket <ticket>`                                       | one ticket's cases and its runs                                                                                                                                                                                         |
| `case <ticket> <caseId>`                                | one case's results in every run, its screenshots and the evidence picked for it                                                                                                                                         |
| `ledger <ticket>`                                       | `{ results, runs }`: the rows a ticket's QA ledger is built from                                                                                                                                                        |
| `evidence`                                              | picked screenshots by ticket                                                                                                                                                                                            |

Tickets and case ids match whatever their case; `--ticket ""` lists the runs with no ticket. `ledger` answers a ticket it has nothing for with empty lists (exit 0).

### A run

`run` is the run's own record (`id`, `ticket`, `run_number`, `label`, `env`, `branch`, `kind`, `verdict`, `summary`, `first_failure_step`, `started_at`, `finished_at`, `app_versions`, `batch_id`, `lane`), and:

- `cases`: one per case the run recorded, in step order: `ticket`, `caseId`, `result` (`PASS`, `FAIL`, `BLOCKED` or `NOT_RUN`), `actual`, `note`, `steps` (`{ from, to }`, the step numbers the case covered, or null for a case that never began), `judgedBy` (`checks` or `session`), `checksResult`, `checks` (each `{ seq, path, check, want, got, ok }`), `runNumber`, `finishedAt`.
- `artifacts`: `stepSeq`, `kind` (`screenshot`, `trace`, …), `name`, `bytes`, `url` (a screenshot's path), `openWith` (how to open it; traces are never printed, only the command that opens them).
- `lanes`: the other runs of the same batch, `{ id, lane, verdict }`.

### A step

`seq`, `tool`, `args`, `ok`, `errorCode`, `pageKind`, `url`, `durationMs`, `observation` (the tool's answer: `ok`, `data`, `notices`, or `code`, `message`, `hint`; an answer longer than 4000 characters is kept as `{ truncated: true, head }`, `head` being the start of its JSON text), `screenshot` (the step's last screenshot) and `screenshots` (every one, in the order taken). Screenshots are absolute paths.

## The run folder

`<resultsDir>/runs/<runId>/` holds:

- `steps.jsonl`: one line per step as it happened (`t`, `seq`, `tool`, `args`, `ok`, `code`, `page`, `ms`), for following a run live. The full answer of each step is in `steps`.
- `screenshots/<NNNN>-<tool>-<label>.png`: NNNN is the step number, four digits. The label says what the shot is: `verify` (the evidence for a check), `fail` (the page when the step failed), `shot` (asked for), `frame` (taken while the tool worked; `frame-2`, `frame-3` and so on in order). A repeated label in one step gets `-2`, `-3`.
- `trace-<actor>-<app>-<n>.zip`: Playwright traces, kept only for a run with a failed step or a verdict other than PASS. They can hold credentials: open them with `npx playwright show-trace`, never read them.
- For runs of the steps runner: `script.json` (the case file or call list that ran) and `runner.log`.

Picked evidence is copied to `<resultsDir>/evidence/<ticket>/<case>-<slug>.png`, apart from the run, so it outlives the run's retention.

## What lasts

Runs, their steps, artifacts and folders are removed after 14 days (3 for runs made only to exercise a tool; `WITNESS_RETENTION_DAYS`, `WITNESS_TOOL_RETENTION_DAYS`). A case's results, a ticket's run numbers and picked evidence are kept, so `ticket`, `case` and `ledger` still answer for a run that is gone.
