// Page furniture: where the person is, and what an empty section says.
import { html } from 'lit';

/** Where the person is, as links back up; the last item has no link. */
export const crumbs = (items: [string, string | null][]) =>
  html`<sl-breadcrumb class="crumbs">
    ${items.map(([label, href]) =>
      href
        ? html`<sl-breadcrumb-item href=${href}>${label}</sl-breadcrumb-item>`
        : html`<sl-breadcrumb-item>${label}</sl-breadcrumb-item>`,
    )}
  </sl-breadcrumb>`;

export const empty = (text: string) => html`<div class="empty">${text}</div>`;
