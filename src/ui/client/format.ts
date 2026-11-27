// Plain text for the pages: counts, times, durations, builds and run names.
import type { Build, Builds } from './api.js';

export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export const fmtTime = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

export const ago = (iso: string | null | undefined) => {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
};

export const dur = (ms: number | null | undefined) => {
  if (ms == null) return '';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
};

export const runMs = (r: { started_at: string; finished_at: string | null }) =>
  r.finished_at ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime() : null;

export const isBuild = (b: unknown): b is Build => !!b && typeof b === 'object' && 'sha' in b;
export const buildLabel = (b: unknown) =>
  isBuild(b)
    ? `${b.branch ? b.branch.replace(/^(feat|fix|feature)\//, '') : 'detached'}@${b.sha}${
        b.dirty ? ' +local' : ''
      }`
    : '';
export const buildsLine = (builds: Builds | null) =>
  Object.entries(builds ?? {})
    .filter(([, b]) => isBuild(b))
    .map(([n, b]) => `${n} ${buildLabel(b)}`)
    .join(' · ');

/** A run by its number, "#3", with its lane when it ran in one; a run with no number by label. */
export const runName = (r: {
  label: string | null;
  run_number?: number | null;
  lane?: number | null;
}) => (r.run_number ? `#${r.run_number}${r.lane ? ` lane ${r.lane}` : ''}` : (r.label ?? ''));

/** When a run started and how long it took: "27 Nov, 12:18 · 3 min 27 s". */
export const ranAt = (started: string | null | undefined, finished: string | null | undefined) => {
  if (!started) return '';
  const took = finished ? dur(new Date(finished).getTime() - new Date(started).getTime()) : '';
  return `${fmtTime(started)} · ${took || 'still running'}`;
};
