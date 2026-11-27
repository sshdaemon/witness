// The viewer's hash routes, as links and as a way to go to one.

export const ticketHref = (ticket: string) => `#/ticket/${encodeURIComponent(ticket)}`;
export const caseHref = (ticket: string, caseId: string, runId?: string) =>
  `${ticketHref(ticket)}/case/${encodeURIComponent(caseId)}${
    runId ? `/run/${encodeURIComponent(runId)}` : ''
  }`;
export const runHref = (id: string) => `#/run/${encodeURIComponent(id)}`;
export const go = (href: string) => {
  location.hash = href;
};
