# Testing a feature through the UI

How a session tests a feature with an app's tools on this engine. The app's own test skill says where its case files live, which tool checks its stack, which accounts act and what data it may touch; read it with this.

The tools drive the real app in a browser. Nothing is mocked and nothing reads the app's API or database, so what you observe is what a person would see.

## Plan the checks with the feature

When a change has user-visible behaviour, give its implementation plan a "UI verification" section while you plan, before the code exists:

- **Ticket and topic:** the ticket id (or PR, for example "PR-34") and one short feature title in plain words. The ticket groups every run and case result in the results viewer; the topic is the run's title.
- **Checks:** one line each, as cases with ids (`C1`, `C2`, …), saying what to check and which actors take part. The ids stay the same across runs, so the viewer can show each case's history.
- **Tools missing:** anything no existing tool can do yet.

Ideally missing tools are added while the feature is built, so they are ready when testing starts (see [tools.md](tools.md)). Keep the section up to date as checks pass.

## Case files: the usual way to run a ticket's cases

Write the cases into the ticket's case file, `<name>-cases.json` (format in the README, "Case files"): the logins in `setup`, each case's title, steps, expected result and its commands, preconditions shared by several cases as fixtures, an `expect` on every evidence read so the runner judges the case from its checks, and `uses` on a case that changes state other cases see (the runner names what is missing). Then run it from the app's checkout:

- `npm run steps -- <case file> --env <env>` runs every case; `--cases C3,C7` runs those (with the cases they run after); `--missing` runs only the cases without a PASS on the current build or changed since. Run it in the background and watch its output; it prints each failed check with the value found. For a ticket whose QA ledger already numbers runs by hand, pass `--first-run <highest + 1>` on its first runner run. On a stack on this machine, `--lanes 2` (or 3) runs independent cases at once, each lane with its own browser; worth it when the cases split into groups that share no fixture. A shared stack always runs one lane.
- A case with a read that has no expect waits for your verdict: run with `WAIT_VERDICT=<scratchpad>/verdict.json`, read the answers of its steps (`run_get`, or the runner's output), and write `{"cases": {"C8": {"result": "PASS", "actual": "1 of 6"}}}` after you have read them. A result that overrules the checks needs a `note` saying why. Each new version of the file is applied as you write it; add `"final": true` when you are done, and the runner finishes the run. With lanes, every lane reads the same file: write `final` only once every lane has printed that it is waiting. It stops waiting after 15 minutes without a new version (`--wait-minutes` changes it), and cases nobody judged end BLOCKED.
- The runner does `session_start`, the cases, `cleanup_all`, `run_finish` and `session_end` itself, and keeps the file it ran and its output with the run.

Cases worth keeping after the ticket go into a regression suite with `npm run promote` (README, "Regression suites"), only when the user asks or agrees; a suite runs with `npm run steps -- suites/<area>.json`.

Call the tools one by one (below) to explore a screen, to try a tool, or for a check that does not fit a case file yet.

## Before the first tool call

1. Check the stack with the app's stack tool, for the apps your test needs and the branches you are working on. Stop and tell the user about any problem it lists for an app you need: an app that is down, or one serving a different branch from the code under test, makes every later result meaningless. Restarting or switching branches on a shared stack is the user's call.
2. `session_start` with `ticket` (for example "AB-12"), a `topic` (the ticket id, then the feature or ticket title in plain words, for example "AB-12 Phone number on the order page") and `branch`. The store numbers the run for the ticket and labels it "AB-12 run 3": do not count runs yourself, and pass `label` only for a run that is not for a ticket's cases. For a ticket whose earlier runs were numbered by hand (a "Runs" section in its QA ledger), pass `firstRun` once, one more than the highest number there. The tools put the label after the run tag in every name they make, and `session_start` returns it joined as `namePrefix`, with `runNumber`. Reuse the same topic wording for the same feature. Use `kind: "tool"` only when you are exercising a tool you are writing, not testing a feature.
3. `login` for each actor you need. `SESSION_MISSING` or `SESSION_EXPIRED` returns the command a person must run once; you cannot sign in for them.

## While testing

- **Record each case** when calling tools one by one: `case_begin({ caseId: "C1" })` before the case's first step and `case_end({ caseId: "C1", result, actual })` after its last read. `result` is PASS, FAIL or BLOCKED; `actual` is what the reads showed in a line ("1 of 4 then 1 of 2"), and `note` says why a case was blocked. Every step between the two belongs to the case, so put the case's setup inside it unless several cases share that setup. One case is open at a time. A case that could not run because a setup or an earlier case it depends on failed is recorded with `case_end({ caseId, result: "NOT_RUN", note })` and no `case_begin`. Cases are recorded before `run_finish`; afterwards `case_begin` and `case_end` answer RUN_FINISHED.
- Name everything you create so a person looking at a screenshot can tell what it is and where it came from: the run tag (the tools check it), the label (for example "AB-12 run 3", from `session_start`), then a few plain words. Tools that build a name or message put `namePrefix` in front themselves, so give them plain words. A name a tool uses exactly as given starts with `namePrefix`. A bare tag with a word after it tells the reader nothing.
- Mutating tools only touch what this session created. Shared test accounts are used by other sessions too.
- Judge only from what a reader tool returned. Pass `purpose: "verify"` on the read that is your evidence. A screenshot is for a human, never the evidence.
- An empty result needs a reason. "0 rows" can be correct or a read that failed; confirm with a control (the same view without the filter).
- Do not retry a failing check hoping it changes. If it differs, record the first observation that differed.
- A state the UI cannot create (a precondition no screen offers) is `BLOCKED`, not a reason to improvise through the API or a script.
- **A check no tool can do** is a different case: add the tool, do not script around the gap. A new or changed tool loads with `mcp_reload`, which restarts the tools process and so ends the open run and loses its cleanup records: first run the cleanup tools, `run_finish` (BLOCKED, naming the missing tool) and `session_end`. Then add the tool ([tools.md](tools.md)), call `mcp_reload` (or reconnect the MCP when the new tool does not show up, or the change is to the proxy) and start a new run. Note the tool in the plan's UI verification section.

## Finish

1. `cleanup_all`, with the accounts it needs logged in (it says which). It runs every `*_cleanup` with something left, in the order they must go, and returns what is left. Fix anything it lists under `left` before going on; `session_end` warns about whatever is still there.
2. `run_finish` with a one- or two-sentence summary. A run that recorded cases takes its verdict from them (any FAIL, else any BLOCKED or NOT_RUN, else PASS), so leave `verdict` out; a run without cases passes `PASS`, `FAIL` or `BLOCKED`. Write checks as `ok: <what held>; FAIL: <what differed>` so the viewer shows a checklist. It refuses while a case is still open (CASE_OPEN).
3. `session_end`. A case left open is closed as BLOCKED, and a run without `run_finish` is stored as ABORTED.
4. Start the viewer with `npm run ui` in the background, unless it already answers on port 4477 (or `$WITNESS_PORT` if set). Give the user the link to the ticket (`http://127.0.0.1:4477/#/ticket/<ticket, URL-encoded>`), which lays every case out against every run with its latest result, or to the run (`#/run/<runId>`) when the run has no ticket, with one line per case verdict. Do not narrate the steps or paste `report` into the chat; the viewer shows them.

Results are stored in `~/.witness/` (`WITNESS_RESULTS_DIR`); outside the MCP tools, read them with `npm run -s read -- …` ([read-contract.md](../read-contract.md)), never with sqlite. Runs are removed after 14 days (tool runs after 3); case results, run numbers and picked evidence are kept. `runs_list({ ticket })` lists a ticket's runs and `run_get` returns a run's case results with their step ranges. `report` is raw material for a ticket comment, not text to paste. To put a screenshot on a ticket, keep it with `evidence_pick` and upload the file `evidence_list` returns.
