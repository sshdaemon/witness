import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { prose } from '../prose.js';
import { CASE_RESULTS, defineCases, ticketCases } from './cases.js';
import { CASE, TICKET } from './evidence.js';
import { requireSession } from './session.js';
import { defineTool } from './tool.js';
import { app } from '../app.js';

/** The app's example ticket ids, quoted, for a description: '"AB-12" or "PR-3"'. */
export const ticketExamples = () =>
  app()
    .ticketExamples.map(t => `"${t}"`)
    .join(' or ');

export const ticketId = () =>
  z
    .string()
    .trim()
    .regex(TICKET, 'letters, digits, ., _ and -')
    .describe(`The ticket or pull request, for example ${ticketExamples()}.`);

const caseId = z
  .string()
  .trim()
  .regex(CASE, 'letters, digits, ., _ and -')
  .describe('The case id from the ticket\'s case list, for example "C12".');

const check = z.object({
  seq: z.number().int().min(0).describe('The step the check read; 0 when it was not recorded.'),
  path: z.string().describe('Where in the answer, for example "items[0].stock.left".'),
  check: z.string().describe('equals, contains, excludes, matches, count, exists or error.'),
  want: z.unknown().optional(),
  got: z.unknown().optional(),
  ok: z.boolean(),
});

export function registerCaseTools(server: McpServer) {
  defineTool(
    server,
    'cases_define',
    {
      title: "Store a ticket's case definitions",
      description: prose`
          Stores the cases of a ticket's case file (title, steps, expected result, the fixtures it
          needs, the cases it runs after, its commands and a hash of them), replacing the earlier
          version of each, so the results viewer shows what each case checks. The steps runner
          calls it when a run starts from a case file. Needs no session.`,
      input: z.object({
        ticket: ticketId(),
        cases: z
          .array(
            z.object({
              caseId,
              title: z.string().min(1).max(200),
              steps: z.array(z.string().max(500)).max(30).optional(),
              expected: z.string().max(2000).optional(),
              needs: z.array(z.string().max(60)).max(20).optional(),
              after: z.array(caseId).max(20).optional(),
              block: z.array(z.unknown()).max(200),
              hash: z.string().max(80),
            }),
          )
          .min(1)
          .max(200),
      }),
      idempotent: true,
    },
    ({ ticket, cases }) => ({ data: defineCases(ticket, cases) }),
  );

  defineTool(
    server,
    'ticket_cases',
    {
      title: "A ticket's cases and their latest results",
      description: prose`
          Every case of a ticket, defined or only run, with its latest result, the run it came
          from, the hash of the case version it ran and the builds it ran on; with env, the
          latest result in that environment. The steps runner uses it to pick the cases still
          without a PASS. Needs no session.`,
      input: z.object({ ticket: ticketId(), env: z.enum(app().envs).optional() }),
      readOnly: true,
      idempotent: true,
    },
    ({ ticket, env }) => ({ data: { cases: ticketCases(ticket, env) } }),
  );

  defineTool(
    server,
    'case_begin',
    {
      title: 'Start a test case',
      description: prose`
          Marks where a case's steps start: every step from this call to its case_end belongs to
          the case. One case is open at a time. The ticket comes from session_start when left out;
          given here on a run without one, it becomes the run's ticket and numbers the run (the
          label stays as it was). Fails with NO_TICKET, TICKET_MISMATCH for another ticket than
          the run's, CASE_OPEN while another case has no case_end, CASE_ALREADY_RUN for a case
          this run already recorded, and RUN_FINISHED after run_finish.`,
      input: z.object({ caseId, ticket: ticketId().optional() }),
    },
    ({ caseId: id, ticket }) => {
      const s = requireSession();
      return { data: s.recorder.beginCase(id, ticket) };
    },
  );

  defineTool(
    server,
    'case_end',
    {
      title: "Record a test case's result",
      description: prose`
          Closes the open case with its result and the steps it covered. Called again for a case
          already closed in this run, it replaces the result: the session's judgement after the
          checks; when that differs from what the checks gave, note must say why (NOTE_REQUIRED). A
          result judged by checks must be the one they give (CHECKS_MISMATCH). A case that could
          not run (a setup or an earlier case it depends on failed) is recorded with NOT_RUN and no
          case_begin. Judge PASS or FAIL only from what the tools read back, never from a
          screenshot. Fails with CASE_OPEN while a different case is open, CASE_NOT_STARTED for
          another result without case_begin, TICKET_MISMATCH and RUN_FINISHED as case_begin
          does.`,
      input: z.object({
        caseId,
        ticket: ticketId().optional(),
        result: z.enum(CASE_RESULTS),
        actual: z
          .string()
          .max(2000)
          .optional()
          .describe('What the reads showed, in a line or two: "1 of 4 then 1 of 2".'),
        note: z
          .string()
          .max(2000)
          .optional()
          .describe('Why it was blocked or not run, or why the result differs from its checks.'),
        judgedBy: z
          .enum(['checks', 'session'])
          .optional()
          .describe(
            'checks: the result is what the checks gave. session (default): judged by you.',
          ),
        checks: z
          .array(check)
          .max(200)
          .optional()
          .describe("The expects evaluated on the case's steps, as the steps runner records them."),
        caseHash: z
          .string()
          .max(80)
          .optional()
          .describe('The hash of the case version that ran, from its case file.'),
      }),
    },
    args => {
      const s = requireSession();
      const row = s.recorder.endCase(args);
      return {
        data: {
          ticket: row.ticket,
          caseId: row.case_id,
          result: row.result,
          steps: row.step_from == null ? null : { from: row.step_from, to: row.step_to },
          judgedBy: row.judged_by,
          checksResult: row.checks_result,
        },
      };
    },
  );
}
