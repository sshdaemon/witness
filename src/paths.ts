import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

// Kept apart from the app's config so the read-only viewer can find the results without loading
// an app.

/**
 * Outside the checkout, so every worktree and session shares one store and nothing risky sits next
 * to git.
 */
export const DEFAULT_RESULTS_DIR = resolve(homedir(), '.witness');
export const DB_FILE = 'witness.sqlite';
export const RESULTS_DIR = process.env.WITNESS_RESULTS_DIR
  ? resolve(process.env.WITNESS_RESULTS_DIR)
  : DEFAULT_RESULTS_DIR;
export const DB_PATH = resolve(RESULTS_DIR, DB_FILE);
export const runDir = (runId: string) => resolve(RESULTS_DIR, 'runs', runId);
export const EVIDENCE_DIR = resolve(RESULTS_DIR, 'evidence');

/** The store keeps paths relative to RESULTS_DIR, so it can move. */
export const toStored = (path: string) => relative(RESULTS_DIR, path);
export const fromStored = (path: string) => (isAbsolute(path) ? path : resolve(RESULTS_DIR, path));

/** A saved sign-in of an actor in one app, under the app's root (its checkout). */
export const sessionFile = (root: string, env: string, actor: string, app: string) =>
  resolve(root, '.sessions', env, `${actor}.${app}.json`);
// Who the session belongs to, captured at sign-in. The user may carry no email, so the uid is the
// identity.
export const identityFile = (root: string, env: string, actor: string, app: string) =>
  resolve(root, '.sessions', env, `${actor}.${app}.identity.json`);
