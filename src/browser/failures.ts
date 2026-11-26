import type { Page, Request, Response } from 'playwright';
import { app } from '../app.js';
import { isLocalHost } from '../hosts.js';

/**
 * Counts the server errors (5xx) a page receives, so a page that rendered empty because the backend
 * failed is not reported as "not found".
 */
export function watchServerFailures(page: Page) {
  let count = 0;
  const on = (r: { status(): number }) => {
    if (r.status() >= 500) count++;
  };
  page.on('response', on);
  return { failed: () => count > 0, stop: () => page.off('response', on) };
}

/** A finished data request; status null when no response came back (error says why). */
export type HttpEntry = {
  method: string;
  url: string;
  status: number | null;
  error: string | null;
  at: string;
};

// The browser cancelling a request (a page left mid-load) is not the app failing.
const ABORTED = 'net::ERR_ABORTED';
export const isAborted = (e: HttpEntry) => e.status === null && e.error === ABORTED;

export type HttpRead = {
  since: string;
  /** Data requests that finished in the window and match the filter, failed or not. */
  requests: number;
  /** The ones with a status of 400 or more, or no response, oldest first. */
  failed: HttpEntry[];
  /** Requests the browser cancelled itself; not in failed. */
  aborted: number;
  /** Requests older than the kept window, so not counted above. */
  notKept: number;
};

const DATA_TYPES = new Set(['document', 'fetch', 'xhr']);
const KEEP = 1000;

export const isFailure = (e: HttpEntry) => !isAborted(e) && (e.status === null || e.status >= 400);

/** Counts and failures among entries, optionally only those whose URL contains some text. */
export function summarise(entries: HttpEntry[], urlContains?: string) {
  const matching = urlContains ? entries.filter(e => e.url.includes(urlContains)) : entries;
  return {
    requests: matching.length,
    failed: matching.filter(isFailure),
    aborted: matching.filter(isAborted).length,
  };
}

/**
 * The page's data requests to the app's own and local hosts (page loads, fetch and XHR; not
 * images or scripts) since it was opened or last cleared.
 */
export class HttpLog {
  private entries: HttpEntry[] = [];
  // A response whose body is cut off also fires requestfailed; count the request once.
  private seen = new WeakSet<Request>();
  private dropped = 0;
  private since = new Date().toISOString();

  private readonly onRes = (r: Response) => this.onResponse(r);
  private readonly onFail = (r: Request) => this.onRequestFailed(r);

  constructor(private readonly page: Page) {
    page.on('response', this.onRes);
    page.on('requestfailed', this.onFail);
  }

  /** Stops logging; for a log kept only while one step runs. */
  stop() {
    this.page.off('response', this.onRes);
    this.page.off('requestfailed', this.onFail);
  }

  private push(req: Request, status: number | null, error: string | null) {
    if (!DATA_TYPES.has(req.resourceType())) return;
    // Third-party calls (maps, analytics) are not the app's.
    const host = new URL(req.url()).hostname;
    if (!app().isOwnHost(host) && !isLocalHost(host)) return;
    if (this.seen.has(req)) return;
    this.seen.add(req);
    this.entries.push({
      method: req.method(),
      url: req.url(),
      status,
      error,
      at: new Date().toISOString(),
    });
    if (this.entries.length > KEEP) {
      this.entries.shift();
      this.dropped++;
    }
  }

  private onResponse(r: Response) {
    this.push(r.request(), r.status(), null);
  }

  private onRequestFailed(req: Request) {
    this.push(req, null, req.failure()?.errorText ?? 'failed');
  }

  read(urlContains?: string): HttpRead {
    return { since: this.since, ...summarise(this.entries, urlContains), notKept: this.dropped };
  }

  clear() {
    this.entries = [];
    this.dropped = 0;
    this.since = new Date().toISOString();
  }
}
