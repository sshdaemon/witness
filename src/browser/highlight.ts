import type { ElementHandle, Locator, Page } from 'playwright';

const SLOW_MO = Number(process.env.WITNESS_SLOWMO) || 0;
const OVERLAY_ID = '__witness_seen__';
const MARKS_ID = '__witness_marks__';

// Watch-mode aid: outlines the element about to be acted on. No-op unless WITNESS_SLOWMO is set.
export async function seen(locator: Locator): Promise<Locator> {
  if (SLOW_MO > 0) {
    await locator
      .first()
      .evaluate((el, id) => {
        document.querySelector(`#${id}`)?.remove();
        const r = el.getBoundingClientRect();
        const box = document.createElement('div');
        box.id = id;
        Object.assign(box.style, {
          position: 'fixed',
          left: `${r.left}px`,
          top: `${r.top}px`,
          width: `${r.width}px`,
          height: `${r.height}px`,
          border: '2px solid #ff3b30',
          background: 'rgba(255, 59, 48, 0.12)',
          zIndex: '2147483647',
          pointerEvents: 'none',
        });
        document.body.append(box);
      }, OVERLAY_ID)
      .catch(() => {});
    await locator.page().waitForTimeout(SLOW_MO);
  }
  return locator;
}

// Evidence screenshots: what a step changed, checked, configured or searched is marked in yellow.

type Target = Locator | ElementHandle;
export type Mark = { page: Page; target: Target; all: boolean; max: number };
type Box = { x: number; y: number; width: number; height: number };

const MAX_BUFFERED = 200;
const MAX_PER_MARK = 12;
const BOUND = 500; // best effort: looking for an element must never cost more than this
const isLocator = (t: Target): t is Locator => typeof (t as Locator).first === 'function';

let buffer: Mark[] = [];
let sink: { next: () => string; frames: string[] } | undefined;

/**
 * Remembers an element to highlight in the next evidence screenshot. With `all`, every match is
 * marked, up to `max`.
 */
export function mark(page: Page, target: Target, opts: { all?: boolean; max?: number } = {}) {
  const all = opts.all ?? false;
  if (
    isLocator(target) &&
    buffer.some(
      m =>
        m.page === page &&
        isLocator(m.target) &&
        String(m.target) === String(target) &&
        m.all === all,
    )
  )
    return;
  if (buffer.length >= MAX_BUFFERED) buffer.shift();
  buffer.push({ page, target, all, max: opts.max ?? MAX_PER_MARK });
}

/**
 * Starts collecting the evidence frames of one tool call; `next` names each frame's file. Marks
 * left over from before are dropped.
 */
export function beginFrames(next: () => string) {
  buffer = [];
  sink = { next, frames: [] };
}

/**
 * Captures what is still marked, ends the collection and returns the frames of the call in order.
 */
export async function endFrames(): Promise<string[]> {
  const current = sink;
  if (current) {
    for (const page of new Set(buffer.map(m => m.page))) await frame(page);
  }
  sink = undefined;
  buffer = [];
  return current?.frames ?? [];
}

/**
 * A screenshot of the page now, with its marks drawn, added to the current step. Nothing marked and
 * visible means no frame.
 */
export async function frame(page: Page): Promise<string | undefined> {
  if (!sink) {
    buffer = buffer.filter(m => m.page !== page);
    return undefined;
  }
  const path = sink.next();
  const drawn = await capture(page, path);
  if (drawn) sink.frames.push(path);
  return drawn ? path : undefined;
}

/** A page screenshot as the page shows it. */
export const shot = (
  page: Page,
  options: Parameters<Page['screenshot']>[0] = {},
): Promise<Buffer> => page.screenshot(options);

/**
 * Writes a screenshot with the page's marks drawn, consuming them; with `within`, only that
 * element's box is kept. False when nothing marked is visible.
 */
export async function capture(page: Page, path: string, within?: Locator): Promise<boolean> {
  const mine = buffer.filter(m => m.page === page);
  buffer = buffer.filter(m => m.page !== page);
  if (mine.length === 0) return false;
  try {
    // Scroll the card to the middle so a clip of it is inside the viewport.
    if (within)
      await within
        .evaluate(e => e.scrollIntoView({ block: 'center' }), undefined, { timeout: BOUND })
        .catch(() => {});
    const boxes = await resolveMarks(page, mine);
    if (boxes.length === 0) return false;
    await drawMarks(page, boxes);
    await page.waitForTimeout(80); // let a selection or a dialog finish animating before the shot
    const clip = within ? await within.boundingBox({ timeout: BOUND }).catch(() => null) : null;
    await shot(page, { path, ...(clip && { clip }) });
    return true;
  } catch {
    return false;
  } finally {
    await clearMarks(page);
  }
}

// Whether the element is what the page shows at the middle of its visible part, so one clipped by a
// scrolled container or covered by something is not marked.
function isShownAt(node: Element, b: Box): boolean {
  const cx = (Math.max(b.x, 0) + Math.min(b.x + b.width, innerWidth)) / 2;
  const cy = (Math.max(b.y, 0) + Math.min(b.y + b.height, innerHeight)) / 2;
  const hit = document.elementFromPoint(cx, cy);
  return !!hit && node.contains(hit);
}

const boxOf = (el: Target) =>
  (isLocator(el) ? el.boundingBox({ timeout: BOUND }) : el.boundingBox()).catch(() => null);

// Boxes in viewport coordinates. The first mark that exists is scrolled into view first, so the
// shot shows it.
export async function resolveMarks(page: Page, marks: Mark[]): Promise<Box[]> {
  const els: Target[] = [];
  for (const m of marks) {
    try {
      if (!isLocator(m.target)) els.push(m.target);
      else if (m.all) els.push(...(await m.target.all()).slice(0, m.max));
      // an absent element costs nothing
      else if ((await m.target.count()) > 0) els.push(m.target.first());
    } catch {
      // the page moved on: nothing to mark
    }
  }
  for (const el of els) {
    if (!(await boxOf(el))) continue;
    await el.scrollIntoViewIfNeeded({ timeout: BOUND }).catch(() => {});
    break;
  }
  const view = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const boxes: Box[] = [];
  for (const el of els) {
    const box = await boxOf(el);
    if (!box || box.width < 2 || box.height < 2) continue;
    if (box.y + box.height < 0 || box.y > view.h || box.x + box.width < 0 || box.x > view.w)
      continue;
    const shown = await (
      isLocator(el) ? el.evaluate(isShownAt, box, { timeout: BOUND }) : el.evaluate(isShownAt, box)
    ).catch(() => false);
    if (shown) boxes.push(box);
  }
  return boxes;
}

export async function drawMarks(page: Page, boxes: Box[]) {
  await page.evaluate(
    ({ boxes: targets, id }) => {
      document.querySelector(`#${id}`)?.remove();
      const layer = document.createElement('div');
      layer.id = id;
      // Multiply on the layer, not on its children (they would only blend inside it), so the page
      // text stays dark under the marker.
      Object.assign(layer.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147483647',
        pointerEvents: 'none',
        mixBlendMode: 'multiply',
      });
      for (const box of targets) {
        const rect = document.createElement('div');
        Object.assign(rect.style, {
          position: 'absolute',
          left: `${box.x - 3}px`,
          top: `${box.y - 3}px`,
          width: `${box.width + 6}px`,
          height: `${box.height + 6}px`,
          background: 'rgba(255, 221, 0, 0.55)',
          border: '2px solid #e6b800',
          borderRadius: '4px',
        });
        layer.append(rect);
      }
      document.body.append(layer);
    },
    { boxes, id: MARKS_ID },
  );
}

/** Removes the overlay and the ROW_ATTR tags an app's readers put on rows. */
export const clearMarks = (page: Page) =>
  page
    .evaluate(
      ({ id, attr }) => {
        document.querySelector(`#${id}`)?.remove();
        document.querySelectorAll(`[${attr}]`).forEach(e => e.removeAttribute(attr));
      },
      { id: MARKS_ID, attr: ROW_ATTR },
    )
    .catch(() => {});

/** The attribute that tags a row the reader has just read, so it can be marked by a locator. */
export const ROW_ATTR = 'data-witness-read';
