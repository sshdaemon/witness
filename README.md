# witness

Test a web app through its real UI from an MCP client, the way a person would: a browser, the app's own screens, test accounts, and nothing mocked behind it. witness is the engine. An app brings its page objects and tools; witness serves them over MCP and records every step, screenshot and verdict in a local results store, with a runner for case files and a viewer for the results.

It is written for a coding agent (Claude Code or any MCP client) that works on a feature and needs to check it in the running app: plan the checks, run them, judge from what the tools read back, and hand over a link.

## What an app provides

An app is a small package of its own that depends on witness:

- **Page objects**: selectors and waits for its screens, with Playwright.
- **Tools**: `defineTool` actions and reads built on the page objects ("create a product", "read the cart"), each returning data the agent can judge.
- **An app definition** (`AppDefinition`): its environments, sites and actors, its hosts and how to reach them, how a person signs in once, how to recognise its pages, what its tools can create and in which order to clean it up, and hooks around sessions and tools.
- **Three entry files**: the MCP entry (`runProxy`), the worker (`setApp` and `runWorker`), and the runner commands (`setApp` and `runCli`).

```ts
// worker.ts
import { runWorker, setApp } from 'witness';
import { shop } from './app.js';

setApp(shop);
runWorker();
```

```ts
// index.ts, the file the MCP registration starts
import { join, resolve } from 'node:path';
import { runProxy } from 'witness/proxy';

// root: the app's checkout. Saved sign-ins live under it and the worker runs there.
const root = resolve(import.meta.dirname, '..');
await runProxy({ name: 'shop-ui', worker: join(import.meta.dirname, 'worker.ts'), root });
```

```ts
// cli.ts: npm run steps / qa-md / promote
import { join } from 'node:path';
import { setApp } from 'witness';
import { runCli } from 'witness/cli';
import { shop } from './app.js';

setApp(shop);
await runCli(process.argv.slice(2), { worker: join(import.meta.dirname, 'worker.ts') });
```

The app's literal names (environments, sites, actors, what its tools create) reach tool code through module augmentation of `Register` in `witness/app`, so tools keep exact types without type parameters everywhere.

The proxy restarts the worker on `mcp_reload`, so edited tools take effect without reconnecting the client.

### Installing

witness is installed from git, pinned to a commit:

```bash
npm install github:sshdaemon/witness#<commit>
npm install playwright zod @modelcontextprotocol/server tsx
```

Playwright, zod and the MCP server SDK are peer dependencies: the app's pages, tool schemas and tool registrations pass their objects to the engine, so both must share one copy. `tsx` runs everything, since witness ships TypeScript source.

The app's scripts run the engine's commands:

```json
{
  "steps": "tsx src/cli.ts steps",
  "qa-md": "tsx src/cli.ts qa-md",
  "promote": "tsx src/cli.ts promote",
  "ui": "tsx node_modules/witness/src/ui/server.ts",
  "read": "tsx node_modules/witness/src/read/cli.ts"
}
```

Because the source is TypeScript, the app's `tsc` checks it with the app's compiler options. Use options compatible with witness's own `tsconfig.json`: `module` and `moduleResolution` `NodeNext`, `lib` with `DOM` (page objects run code in the browser), `strict`, and no `exactOptionalPropertyTypes`.

## What witness provides

- **Sessions and runs**: `session_start`, `login`, `run_finish`, `session_end`, with saved sign-ins per actor and site, a host guard that keeps the browser inside the chosen environment, and per-run names so a person can tell test data apart.
- **Cases**: `case_begin` and `case_end` record each test case's result against a ticket, so a ticket's cases can be compared across runs.
- **Cleanup**: everything a session creates is tracked; `cleanup_all` removes it in the order the app gives.
- **Evidence**: steps mark what they changed or read in yellow in their screenshots; `evidence_pick` keeps a screenshot for a ticket.
- **The runner**: `npm run steps` runs a case file or a plain list of calls through a fresh worker, in parallel lanes on a stack of your own.
- **The results store and viewer**: SQLite and run folders in `~/.witness/`, a read-only viewer on the loopback address, and a read CLI.

## Case files

A ticket's test cases live in one JSON file, `<name>-cases.json`, which the runner runs case by case in one run:

```json
{
  "ticket": "AB-12",
  "title": "Stock limit on the product page",
  "env": { "local": { "storeId": "s-local" }, "staging": { "storeId": "s-staging" } },
  "setup": [
    ["login", { "actor": "seller" }],
    ["login", { "actor": "buyer" }]
  ],
  "fixtures": {
    "limited": [["product_create", { "actor": "seller", "name": "limited" }, { "as": "limited" }]]
  },
  "cases": {
    "C1": {
      "title": "Stock left after an order",
      "actor": "buyer",
      "kind": "edge",
      "steps": ["Order 1 of the limited product", "Open the product page"],
      "expected": "The page shows 1 left.",
      "needs": ["limited"],
      "after": [],
      "block": [
        [
          "product_read",
          { "id": "{{limited.id}}", "purpose": "verify" },
          { "expect": [{ "path": "stock.left", "equals": "1" }] }
        ]
      ]
    }
  }
}
```

- A call is `[tool, args, options]`. `{"as": name}` keeps the call's data under that name, merged across calls, for `{{name.field}}` later. `{{env.key}}` reads the run's environment block. `{{TAG}}` is the run tag, and the app's `runner.capture` names values tools leave for later calls (`{{PAGE}}`, a list's `{{SKU1}}`, `{{SKU2}}`, …). `["sleep", {"seconds": 60}]` waits, and so does any call named in the app's `runner.waits`.
- `setup` holds the logins the cases rely on and runs first in every run, and in every lane. If it fails, no case runs.
- A fixture is built once, the first time a case needs it, outside any case. `after` runs a case after others; the selected cases bring their `after` cases with them.
- `expect` checks the call's data: a path (`items[0].x`, `items[*].x`, `items[name=None].x`) and one of `equals`, `contains`, `excludes`, `matches` (a regular expression), `count` or `exists`. `{"error": "CODE", "message": "text"}` says the call must fail that way. Every check is stored with what it found.
- Each case runs between `case_begin` and `case_end`. A failed check makes it FAIL and it carries on; a tool error makes it BLOCKED and stops it, and the cases after it are NOT_RUN.
- A case whose evidence reads (`purpose: "verify"`) all carry an expect is judged by its checks. Any other case waits for a verdict: with `WAIT_VERDICT=<file>` the runner applies each new version of `{"cases": {"C8": {"result": "PASS", "actual": "…", "note": "…"}}, "summary": "…", "final": true}` as it is written, and finishes the run once a version says `"final": true`, or after `--wait-minutes` (15 by default) without a new version.
- `--lanes <n>` (up to 4) splits the cases into lanes that run at once, each its own worker, session and browser. A case stays in one lane with the cases it runs after, the cases needing one of its fixtures and the cases sharing one of its `uses` values (state every lane sees, named by the app's `runner.sharedState`). A stack that is not on this machine is shared, so it always runs one lane.
- `--missing` runs the cases that never ran in the environment, did not pass last time, changed since, or passed on another build of an app the stack still serves.
- `npm run qa-md -- <case file>` rewrites the generated sections of the ticket's QA ledger (`<name>.qa.md` next to the case file): the case table with each case's latest result per environment, and one line per run.

## Regression suites

Cases worth running again after their ticket is done go into `suites/<area>.json` in the app's checkout, a case file named `REG-<AREA>` that runs like any other. `npm run promote -- <case file> <ids> --suite <area>` copies the cases with the cases they run after, the fixtures they need and the env values and logins they use, gives them the suite's next ids (R1, R2, …) and records the version they came from. The suite is formatted with the app's `oxfmt` when it has one. Only a case the runner judges from its checks can go in, since a suite runs with nobody to judge it.

## Results

```
~/.witness/
  witness.sqlite              runs, steps, artifacts, evidence, cases and case results
  runs/<run-id>/
    steps.jsonl
    script.json, runner.log   the case file as it ran, and what the runner printed
    screenshots/0007-orders_read-verify.png
    trace-<actor>-<app>-N.zip  only for a run with a failed step or a verdict other than PASS
  evidence/<ticket>/c3-order-list-shows-the-order.png
```

`WITNESS_RESULTS_DIR` moves it. Anything outside the server reads it through the read CLI or module, never the database directly: see [docs/read-contract.md](docs/read-contract.md). Runs are removed after 14 days, and runs made only to exercise a tool after 3 (`WITNESS_RETENTION_DAYS`, `WITNESS_TOOL_RETENTION_DAYS`); case results, run numbers and picked evidence are kept.

The viewer (`tsx node_modules/witness/src/ui/server.ts`, on `http://127.0.0.1:4477`, `WITNESS_PORT` to change) lists tickets, the most recently tested first, with how their cases stand and their last run's verdict (tool checks in a collapsed section). A ticket opens to its use cases, its latest run and, folded, its run history; a case opens to its result in a chosen run, with that run's steps, and a presentation mode that steps through the screenshots with the arrow keys. Its browser code is TypeScript with Lit and Shoelace, bundled by the viewer on the first load and again after a client file changes, so there is no build step. It is read-only, listens on the loopback address only and never serves traces, which can hold credentials.

Other settings: `WITNESS_BROWSER_CHANNEL` (a Playwright browser channel) and `WITNESS_SLOWMO` (milliseconds between browser actions).

## Data handling

Use dedicated test accounts, never production. Saved sign-ins, browser profiles, traces and the results store can hold credentials: keep them out of git, and treat `~/.witness/` as sensitive. The engine sets nothing aside for you beyond that; an app decides which hosts its environments may reach.

## Method

[docs/method/testing.md](docs/method/testing.md) is how an agent tests a feature with an app's tools, and [docs/method/tools.md](docs/method/tools.md) how it adds a tool. An app's own skills point at them and add what is specific to the app.

## With a QA loop

The [fresh-eyes](https://github.com/sshdaemon/workbench) QA loop drives an app built on witness for a ticket end to end: it defines the cases into a case file, has a fresh-context validator challenge them, runs them with `npm run steps`, has the validator check every verdict against the steps and screenshots, and hands over the viewer link. Its [profile recipes](https://github.com/sshdaemon/workbench/blob/main/plugins/fresh-eyes/PROFILE.md#recipes) have what the project's profile says about the app.

## Development

```bash
npm install
npx lefthook install   # pre-commit checks
npm run check         # lint, format check, typecheck and tests
```

Tests run the engine against a small demo app in `test/helpers/app.ts`.

## Licence

MIT
