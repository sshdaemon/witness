# Adding a tool

How to add or change a tool of an app built on this engine. The app's own tool skill says where its code lives, which of its files need approval to change and how it commits; read it with this.

A tool is a small, named action or read on one screen, written so a model gets the same answer every time.

## Layout

- **Page objects** know the selectors and waits for one screen; **tool files** register tools with `defineTool`, call page objects and return `{ data, notices }`. The app's definition (`AppDefinition`) registers its tool files in `registerTools`.
- The engine's browser helpers (`settle`, `untilStable`, `mark`, `frame`, `seen`, `HttpLog`) and the app's own shared helpers: reuse before adding.
- The session (`requireSession`) holds per-run state, including what the session created, for cleanup. State only the app's tools use goes in the app's session state type and is read as `session.state`.
- The engine serves any app and never imports app code, and app code imports it only as the package `witness` (the proxy from `witness/proxy`, the runner commands from `witness/cli`, the app definition's types to augment from `witness/app`). A helper the engine has but does not export there gets added to the index, not imported from its file. Code that names the app's screens, hosts or accounts stays in the app; the engine reaches it through the app definition.
- Read two existing tools of the same kind first (a read and a mutation).

## Rules that keep it deterministic

- UI only. No `fetch`, no API URL, no database. The engine's guard blocks the app's requests outside the chosen environment, using the hosts the app definition names.
- Wait for the request that carries the new state, not for time. Register `page.waitForResponse(...)` before the action, make sure a failure before the await cannot become an unhandled rejection, and judge the response (`ok()`, status), not only the page. A failed request often renders an empty state.
- Never turn "could not read" into an empty result. Return `unknown` or throw a `ToolError` with a code and a hint (`SITE_UNREACHABLE`, `ROWS_STILL_MOVING`, `NOT_ALLOWED`). A tool that cannot tell success from failure will make runs pass wrongly.
- Poll with `untilStable` until a read holds still, and throw a coded error (`ROWS_STILL_MOVING`) when it returns `settled: false`. Do not hand-roll a polling loop. Tables and lists often swap rows in place.
- Hidden radio and checkbox inputs: click the visible label. Icon-only buttons have no name: find them by structure. Strict locators: match exactly (`"Add item"` also matches `"Add item note"`).
- Mutations are owned-only. Record what the session creates with `session.created.track(kind, record)` as soon as it exists, so a failed run can still clean up, and refuse to change anything else with `session.created.require(kind, match, () => new ToolError("NOT_OWNED", …))`. A new kind goes in the app's kinds and its cleanup order; its `*_cleanup` tool calls a function also passed to `registerCleanup`, so `cleanup_all` runs it in order.
- Names carry the run tag first, then words a person can read. Let the caller pass the rest of the name (ticket or PR, run number, what it is) wherever the screen takes a name, and build defaults with `session.name(words, max)` (tag, label, words, shortened to the field's limit), not the tag plus a suffix. Ownership checks look for the tag anywhere it is required, not for an exact default. Dates are real dates (`realDate`).
- Show the evidence. For what the tool changes, reads or searches call `mark(page, locator)`, and before leaving a state worth keeping (a wizard question answered, a popup before Apply) `await frame(page)`. Marked elements are drawn in yellow, with no text on top, in the step's screenshots in the viewer. Mark what a person would look at (the answer chosen, the rows found, the saved row after it appears), not the Next button. Use `{ all: true }` for rows. Elements that are clipped or covered are skipped.
- Reads that serve as evidence take `purpose: "verify"` and keep their shot with `session.screenshot(h, 'verify')` or `session.elementShot(h, 'verify', area)`: give a plain label, the recorder names the file after the step and tool (`0007-orders_read-verify.png`).
- Evidence screenshots show what was read: mark the element, scroll it into view, and crop to the element where a page-wide shot would bury it in unrelated content. A page may hold a second, hidden copy of a row for another screen size: read and mark the visible one. After writing a reader, look at one verify screenshot yourself.
- Errors: one `ToolError(code, message, hint)` each, with a hint saying what to do next.
- Lines stay within 100 columns (a test checks it). Write a long description, hint or message as a `prose` template, wrapped over lines: line breaks and indentation become single spaces, so the text is unchanged. Not in code that runs in the browser (`page.evaluate`, `evaluateAll`, `waitForFunction` callbacks): `prose` does not exist there, so use `+` or an array `join` (a test checks this too).
- Comments: few, one line, only for a non-obvious why.

## Exploring a screen that is new

Log in with `login`, then use `goto`, `read_page` and `screenshot` to look at the real page. The app's recogniser names page kinds and its `gotoAllowed` routes limit which routes `goto` accepts; add the route there. If the feature is not merged, the stack must serve its branch: check it with the app's stack tool. Do not guess selectors from the feature code alone; confirm them on the live page, and wait for the user-visible text rather than test ids unless the page has them.

## Verify

1. `npm run format`, then `npm run check` (lint, format check, typecheck, unit tests). Add unit tests for anything that parses or decides (not for browser steps).
2. Run the tool against a live stack at least twice, including once where the precondition is missing, to see the error path. The tool is not done until a real run has passed. Drive it through the MCP itself (`mcp_reload` after `session_end`, or reconnect when the client does not pick up the changed tool list) so it is proven the way it will be used; when a session cannot reload, run the calls through `npm run steps`. Do not add test scripts or markdown cases to the repo; a throwaway exploration script belongs in a scratch folder.
3. Document the tool in the app's tool list and describe it well in its `description`: what it reads or changes, which actor, and the codes it can fail with.
4. Load the change with `mcp_reload` (after `session_end`); a change to the server instructions (such as a new cleanup kind) or to the proxy still needs a reconnect.
