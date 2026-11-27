// A step's screenshots and its error.
import { html, nothing } from 'lit';
import type { Step } from '../api.js';

export const stepShots = (s: Step) => {
  if (s.screenshots.length > 0) return s.screenshots;
  return s.screenshot ? [s.screenshot] : [];
};

export const stepError = (s: Step) => {
  if (s.ok) return nothing;
  const obs = s.observation ?? {};
  return html`<div class="err">
    <strong>${s.errorCode || obs.code || 'error'}</strong> ${obs.message ?? ''}
    ${obs.hint ? html`<span class="hint">— ${obs.hint}</span>` : nothing}
  </div>`;
};
