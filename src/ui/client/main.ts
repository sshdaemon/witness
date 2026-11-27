// The results viewer: a hash router over read-only pages, refreshed every 5 seconds while visible.
import { setBasePath } from '@shoelace-style/shoelace/dist/utilities/base-path.js';
import '@shoelace-style/shoelace/dist/components/badge/badge.js';
import '@shoelace-style/shoelace/dist/components/breadcrumb/breadcrumb.js';
import '@shoelace-style/shoelace/dist/components/breadcrumb-item/breadcrumb-item.js';
import '@shoelace-style/shoelace/dist/components/button/button.js';
import '@shoelace-style/shoelace/dist/components/card/card.js';
import '@shoelace-style/shoelace/dist/components/copy-button/copy-button.js';
import '@shoelace-style/shoelace/dist/components/details/details.js';
import '@shoelace-style/shoelace/dist/components/dropdown/dropdown.js';
import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import '@shoelace-style/shoelace/dist/components/icon-button/icon-button.js';
import '@shoelace-style/shoelace/dist/components/menu/menu.js';
import '@shoelace-style/shoelace/dist/components/menu-item/menu-item.js';
import '@shoelace-style/shoelace/dist/components/tag/tag.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';
import { html, LitElement, nothing, type TemplateResult } from 'lit';
import { caseView, loadCase } from './pages/case.js';
import { evidenceView, loadEvidence } from './pages/evidence.js';
import { loadRun, runView } from './pages/run.js';
import { loadTicket, ticketView } from './pages/ticket.js';
import {
  loadNoTicket,
  loadTickets,
  noTicketView,
  ticketsView,
  toolsView,
} from './pages/tickets.js';
import { WitnessPresent, type Slide } from './present.js';

// Shoelace's icons and the rest of its assets are served by the viewer itself.
setBasePath('/vendor/shoelace');

// Shoelace follows the system's light or dark scheme, as the page's own colours do.
const scheme = window.matchMedia('(prefers-color-scheme: dark)');
const applyScheme = () =>
  document.documentElement.classList.toggle('sl-theme-dark', scheme.matches);
applyScheme();
scheme.addEventListener('change', applyScheme);

// The header's menu: each item's value is the page it opens.
document.querySelector('#menu')?.addEventListener('sl-select', e => {
  const value = (e as CustomEvent<{ item: { value: string } }>).detail.item.value;
  location.hash = value;
});

type Page = { key: string; load: () => Promise<unknown>; view: (data: never) => TemplateResult };

const decode = (part: string | undefined) => {
  try {
    return part === undefined ? undefined : decodeURIComponent(part);
  } catch {
    return undefined; // a hand-edited or truncated link
  }
};

class WitnessApp extends LitElement {
  static override properties = {
    data: { state: true },
    error: { state: true },
  };

  declare data: unknown;
  declare error: string | null;
  private page: Page | undefined;
  private seq = 0;
  private lastJson = '';
  private timer: number | undefined;

  constructor() {
    super();
    this.data = undefined;
    this.error = null;
  }

  // Light DOM, so the page's stylesheet applies.
  protected override createRenderRoot() {
    return this;
  }

  private get presenter() {
    const el = document.querySelector('witness-present');
    return el instanceof WitnessPresent ? el : undefined;
  }

  readonly present = (slides: Slide[], index: number, heading: string) =>
    this.presenter?.open(slides, index, heading);

  /** The page the hash names. */
  private route(): Page {
    const hash = location.hash.replace(/^#\/?/, '');
    const run = /^run\/([0-9a-z-]+)$/.exec(hash);
    const ticket = /^ticket\/([^/]+)(?:\/case\/([^/]+)(?:\/run\/([^/]+))?)?$/.exec(hash);
    const page = /^page\/(\d+)$/.exec(hash);
    if (run) {
      const id = run[1]!;
      return { key: hash, load: () => loadRun(id), view: d => runView(d, this) };
    }
    const t = decode(ticket?.[1]);
    const c = decode(ticket?.[2]);
    if (t !== undefined && c !== undefined) {
      const r = decode(ticket?.[3]);
      return { key: hash, load: () => loadCase(t, c, r), view: d => caseView(d, this) };
    }
    if (t !== undefined) return { key: hash, load: () => loadTicket(t), view: ticketView };
    if (hash === 'evidence') return { key: hash, load: loadEvidence, view: evidenceView };
    if (hash === 'no-ticket') return { key: hash, load: loadNoTicket, view: noTicketView };
    if (hash === 'tools') return { key: hash, load: loadTickets, view: toolsView };
    const n = Number(page?.[1] ?? 1);
    return { key: `page/${n}`, load: loadTickets, view: d => ticketsView(d, n) };
  }

  /** Loads the current page; a slower, older answer never replaces a newer page. */
  private async refresh(navigated = false) {
    if (navigated) {
      this.page = this.route();
      this.lastJson = '';
    }
    const page = this.page ?? (this.page = this.route());
    const seq = ++this.seq;
    try {
      const data = await page.load();
      if (seq !== this.seq) return;
      document.querySelector('#live')?.classList.remove('paused');
      this.error = null;
      // Unchanged data keeps the page as it is.
      const json = JSON.stringify(data);
      if (json === this.lastJson) return;
      this.lastJson = json;
      this.data = data;
    } catch (e) {
      if (seq !== this.seq) return;
      document.querySelector('#live')?.classList.add('paused');
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  private onHash = () => {
    this.presenter?.close();
    this.data = undefined;
    void this.refresh(true);
    window.scrollTo(0, 0);
  };

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('hashchange', this.onHash);
    void this.refresh(true);
    // Not while the tab is hidden or a presentation is open, so neither is disturbed.
    this.timer = window.setInterval(() => {
      if (!document.hidden && !this.presenter?.isOpen) void this.refresh();
    }, 5000);
  }

  override disconnectedCallback() {
    window.removeEventListener('hashchange', this.onHash);
    window.clearInterval(this.timer);
    super.disconnectedCallback();
  }

  override render() {
    if (this.error) return html`<div class="empty">Could not load results: ${this.error}</div>`;
    if (this.data === undefined || !this.page)
      return html`<div class="loading"><span class="muted">Loading…</span></div>`;
    return this.page.view(this.data as never) ?? nothing;
  }
}

customElements.define('witness-app', WitnessApp);
