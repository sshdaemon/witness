import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ToolError } from '../errors.js';
import { EVIDENCE_DIR } from '../paths.js';
import {
  CASE,
  listEvidence,
  markPosted,
  pickEvidence,
  removeEvidence,
  TICKET,
} from './evidence.js';
import { ticketExamples } from './caseTools.js';
import { getSession, recordingSession } from './session.js';
import { defineTool } from './tool.js';
import { prose } from '../prose.js';

const id = z.number().int().min(1).describe('The evidence id from evidence_pick or evidence_list.');

export function registerEvidenceTools(server: McpServer) {
  const ticket = z
    .string()
    .regex(TICKET, 'letters, digits, ., _ and -')
    .describe(`The ticket or pull request the evidence is for, for example ${ticketExamples()}.`);
  defineTool(
    server,
    'evidence_pick',
    {
      title: "Keep a step's screenshot as a ticket's evidence",
      description: prose`
          Copies one screenshot of a run's step into the ticket's evidence folder with a caption,
          and records which run, step and tool it came from. Evidence is kept apart from the run,
          so it outlives the run's retention. Pick the shots that show the expected result: a
          verify read's crop, the marked rows or notification. shot chooses among the step's
          screenshots (1-based position, or part of the file name such as 'verify'); the last one
          by default. Returns the evidence id and the file to upload. Fails with STEP_NOT_FOUND,
          NO_SCREENSHOT, SHOT_NOT_FOUND, SHOT_AMBIGUOUS or SCREENSHOT_GONE.`,
      input: z.object({
        runId: z
          .string()
          .regex(/^[0-9a-z-]+$/)
          .optional()
          .describe('Default: the run in progress, or the one that just ended.'),
        step: z
          .number()
          .int()
          .min(1)
          .describe('The step number, as run_get or the viewer shows it.'),
        shot: z.union([z.number().int().min(1), z.string().min(1).max(60)]).optional(),
        ticket,
        case: z
          .string()
          .regex(CASE)
          .optional()
          .describe('The QA case it proves, for example "C3"; it starts the file name.'),
        caption: z
          .string()
          .trim()
          .min(3)
          .max(200)
          .describe('What the screenshot shows, as the comment will say it.'),
      }),
    },
    ({ runId, step, shot, ticket: t, case: caseId, caption }) => {
      const run = runId ?? (getSession() ?? recordingSession())?.runId;
      if (!run) throw new ToolError('NO_RUN', 'No run in progress or just ended.', 'Pass runId.');
      return { data: pickEvidence({ runId: run, step, shot, ticket: t, caseId, caption }) };
    },
  );

  defineTool(
    server,
    'evidence_list',
    {
      title: "A ticket's evidence",
      description: prose`
          The screenshots picked for a ticket, in the order they were picked: id, case, caption,
          the file to upload, the run and step it came from, and where it was posted once
          evidence_posted recorded it. Without ticket, every ticket with evidence.`,
      input: z.object({ ticket: ticket.optional() }),
      readOnly: true,
      idempotent: true,
    },
    ({ ticket: t }) => {
      const items = listEvidence(t);
      if (t) return { data: { ticket: t, dir: `${EVIDENCE_DIR}/${t}`, items } };
      const tickets = [...new Set(items.map(i => i.ticket))].map(name => ({
        ticket: name,
        items: items.filter(i => i.ticket === name).length,
        posted: items.filter(i => i.ticket === name && i.postedUrl).length,
      }));
      return { data: { tickets } };
    },
  );

  defineTool(
    server,
    'evidence_posted',
    {
      title: 'Record where evidence was uploaded',
      description: prose`
          After an image is uploaded to the ticket (the tracker's asset URL, for example), records
          that address on the evidence so the comment and the run point at each other. Fails with
          EVIDENCE_NOT_FOUND.`,
      input: z.object({ id, url: z.url().describe('The uploaded image address.') }),
      idempotent: true,
    },
    ({ id: evidenceId, url }) => ({ data: markPosted(evidenceId, url) }),
  );

  defineTool(
    server,
    'evidence_remove',
    {
      title: 'Remove a picked screenshot',
      description: prose`
          Removes a screenshot picked by mistake from the ticket's evidence, file and record. The
          run's own screenshot is not touched. Fails with EVIDENCE_NOT_FOUND.`,
      input: z.object({ id }),
      destructive: true,
    },
    ({ id: evidenceId }) => ({ data: { removed: removeEvidence(evidenceId) } }),
  );
}
