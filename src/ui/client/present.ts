import { html, LitElement, nothing } from 'lit';
import type { Step } from './api.js';
import { shortArgs } from './format.js';
import { stepError, stepShots } from './parts/steps.js';
import { verdict } from './parts/verdict.js';

/** One screenshot of a step, or the step alone when it took none. */
export type Slide = { step: Step; src: string | null; frame: number; frames: number };

/** One slide per screenshot, and one for a step that took none. */
export const slidesOf = (steps: Step[]): Slide[] =>
  steps.flatMap(step => {
    const shots = stepShots(step);
    return (shots.length > 0 ? shots : [null]).map((src, frame) => ({
      step,
      src,
      frame,
      frames: shots.length,
    }));
  });

/**
 * Steps one at a time, full screen: ← → (or PageUp / PageDown, space) move, Home and End jump to
 * the ends, Esc leaves.
 */
export class WitnessPresent extends LitElement {
  static override properties = {
    slides: { attribute: false },
    index: { state: true },
    heading: { attribute: false },
  };

  declare slides: Slide[];
  declare index: number;
  declare heading: string;

  constructor() {
    super();
    this.slides = [];
    this.index = 0;
    this.heading = '';
  }

  // Light DOM, so the page's stylesheet applies.
  protected override createRenderRoot() {
    return this;
  }

  get isOpen() {
    return this.slides.length > 0;
  }

  open(slides: Slide[], index: number, heading: string) {
    this.slides = slides;
    this.heading = heading;
    this.show(index);
    document.body.classList.add('presenting');
    window.addEventListener('keydown', this.onKey);
    this.requestFullscreen?.().catch(() => {});
  }

  close() {
    if (!this.isOpen) return;
    this.slides = [];
    document.body.classList.remove('presenting');
    window.removeEventListener('keydown', this.onKey);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.dispatchEvent(new Event('closed'));
  }

  private show(index: number) {
    this.index = Math.min(Math.max(index, 0), this.slides.length - 1);
    // Load the next screenshot ahead, so moving on shows it at once.
    const next = this.slides[this.index + 1];
    if (next?.src) new Image().src = next.src;
  }

  private onKey = (e: KeyboardEvent) => {
    const moves: Record<string, () => number> = {
      ArrowRight: () => this.index + 1,
      ArrowDown: () => this.index + 1,
      PageDown: () => this.index + 1,
      ' ': () => this.index + 1,
      ArrowLeft: () => this.index - 1,
      ArrowUp: () => this.index - 1,
      PageUp: () => this.index - 1,
      Home: () => 0,
      End: () => this.slides.length - 1,
    };
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      return;
    }
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    this.show(move());
  };

  override connectedCallback() {
    super.connectedCallback();
    // Leaving full screen with the browser's own Esc also leaves the presentation.
    document.addEventListener('fullscreenchange', this.onFullscreen);
  }

  override disconnectedCallback() {
    document.removeEventListener('fullscreenchange', this.onFullscreen);
    window.removeEventListener('keydown', this.onKey);
    super.disconnectedCallback();
  }

  private onFullscreen = () => {
    if (!document.fullscreenElement && this.isOpen) this.close();
  };

  protected override updated() {
    this.querySelector('.film.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  override render() {
    if (!this.isOpen) return nothing;
    const n = this.slides.length;
    const x = this.slides[this.index]!;
    const s = x.step;
    return html`<div class="present" role="dialog" aria-modal="true" aria-label="Presentation">
      <div class="p-top">
        <div class="p-title"><strong>${this.heading}</strong></div>
        <div class="p-count">${this.index + 1} / ${n}</div>
        <sl-icon-button
          name="x-lg"
          label="Leave presentation"
          @click=${() => this.close()}
        ></sl-icon-button>
      </div>
      <div class="p-step ${s.ok ? '' : 'bad'}">
        <span class="seq">${s.seq}</span><span class="tool">${s.tool}</span>
        <span class="args">${shortArgs(s.args)}</span>
        ${
          x.frames > 1
            ? html`<span class="muted">screenshot ${x.frame + 1} of ${x.frames}</span>`
            : nothing
        }
        ${s.ok ? nothing : verdict('FAIL')}
      </div>
      ${stepError(s)}
      <div class="p-stage">
        <sl-icon-button
          class="p-prev"
          name="chevron-left"
          label="Previous"
          ?disabled=${this.index === 0}
          @click=${() => this.show(this.index - 1)}
        ></sl-icon-button>
        ${
          x.src
            ? html`<img class="p-img" src=${x.src} alt="Step ${s.seq}, ${s.tool}" />`
            : html`<div class="p-noimg muted">This step took no screenshot.</div>`
        }
        <sl-icon-button
          class="p-next"
          name="chevron-right"
          label="Next"
          ?disabled=${this.index === n - 1}
          @click=${() => this.show(this.index + 1)}
        ></sl-icon-button>
      </div>
      <div class="p-film">
        ${this.slides.map(
          (y, i) =>
            html`<button
              class="film ${i === this.index ? 'on' : ''} ${y.step.ok ? '' : 'bad'}"
              aria-label="Step ${y.step.seq}${y.frames > 1 ? `, screenshot ${y.frame + 1}` : ''}"
              @click=${() => this.show(i)}
            >
              ${
                y.src
                  ? html`<img src=${y.src} alt="" loading="lazy" />`
                  : html`<span>${y.step.seq}</span>`
              }
            </button>`,
        )}
      </div>
    </div>`;
  }
}

customElements.define('witness-present', WitnessPresent);

declare global {
  interface HTMLElementTagNameMap {
    'witness-present': WitnessPresent;
  }
}
