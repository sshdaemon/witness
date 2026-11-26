import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { beginFrames, endFrames, frame, mark } from '../src/browser/highlight.js';
import { prose } from '../src/prose.js';

const ROW = 'width:200px;height:30px;background:#fff';
const HTML = `<body style="margin:0;background:#fff">
  <div id="a"
    style="position:absolute;left:40px;top:40px;width:120px;height:40px;background:#fff">Alpha</div>
  <div id="b"
    style="position:absolute;left:300px;top:40px;width:120px;height:40px;background:#fff">Beta</div>
  <ul style="position:absolute;left:40px;top:200px;margin:0;padding:0;list-style:none">
    <li style="${ROW}">one</li><li style="${ROW}">two</li><li style="${ROW}">three</li>
  </ul>
  <div style="position:absolute;left:300px;top:200px;width:100px;height:40px;overflow:hidden">
    <div id="clipped" style="margin-top:100px;height:30px;background:#fff">hidden</div></div>
  <div id="far"
    style="position:absolute;left:40px;top:3000px;width:150px;height:40px;background:#fff">
    Far down</div>
  <div style="height:3200px"></div></body>`;

// Reads one pixel of a PNG by decoding it in the browser.
const pixel = (page: Page, png: Buffer, x: number, y: number) =>
  page.evaluate(
    async ({ b64, px, py }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const [r = 0, g = 0, b = 0] = ctx.getImageData(px, py, 1, 1).data;
      return { r, g, b };
    },
    { b64: png.toString('base64'), px: x, py: y },
  );
const isYellow = (p: { r: number; g: number; b: number }) => p.r > 230 && p.g > 200 && p.b < 170;
const isWhite = (p: { r: number; g: number; b: number }) => p.r > 240 && p.g > 240 && p.b > 240;

describe('evidence screenshots', { concurrency: false }, () => {
  let browser: Browser | undefined;
  let page: Page;
  const dir = mkdtempSync(join(tmpdir(), 'witness-highlight-'));

  before(async () => {
    try {
      browser = await chromium.launch({
        channel: process.env.WITNESS_BROWSER_CHANNEL || undefined,
      });
      page = await browser.newPage({ viewport: { width: 600, height: 400 } });
    } catch {
      browser = undefined; // no browser on this machine: the tests below skip
    }
  });
  after(() => browser?.close());

  let frames = 0;
  const nextFrame = () => join(dir, `frame-${++frames}.png`);
  const run = async (t: { skip: (m: string) => void }, body: () => Promise<void>) => {
    if (!browser) return t.skip('no browser available');
    await page.setContent(HTML);
    beginFrames(nextFrame);
    await body();
  };

  it('draws yellow on the marked element only, and removes the overlay afterwards', async t => {
    await run(t, async () => {
      mark(page, page.locator('#a'));
      const path = await frame(page);
      assert.ok(path && existsSync(path));
      const png = await readFile(path);
      assert.ok(isYellow(await pixel(page, png, 100, 60)), 'the marked element is yellow');
      assert.ok(isWhite(await pixel(page, png, 360, 60)), 'an unmarked element stays white');
      assert.equal(await page.locator('#__witness_marks__').count(), 0);
      await endFrames();
    });
  });

  it('marks every match with all, up to max', async t => {
    await run(t, async () => {
      mark(page, page.locator('li'), { all: true, max: 2 });
      const png = await readFile((await frame(page))!);
      assert.ok(isYellow(await pixel(page, png, 100, 215)), 'first row');
      assert.ok(isYellow(await pixel(page, png, 100, 245)), 'second row');
      assert.ok(isWhite(await pixel(page, png, 100, 275)), 'third row is beyond max');
      await endFrames();
    });
  });

  it('scrolls the first mark into view', async t => {
    await run(t, async () => {
      mark(page, page.locator('#far'));
      const png = await readFile((await frame(page))!);
      const box = (await page.locator('#far').boundingBox())!;
      assert.ok(isYellow(await pixel(page, png, Math.round(box.x + 60), Math.round(box.y + 20))));
      await endFrames();
    });
  });

  it('does not mark a later element that a container clips', async t => {
    await run(t, async () => {
      mark(page, page.locator('#a'));
      // its box lies in the viewport, but the container hides it
      mark(page, page.locator('#clipped'));
      const png = await readFile((await frame(page))!);
      assert.ok(isYellow(await pixel(page, png, 100, 60)));
      assert.ok(
        isWhite(await pixel(page, png, 350, 315)),
        'nothing is drawn where the clipped element would be',
      );
      await endFrames();
    });
  });

  it(
    prose`
    lets an absent mark neither slow the shot nor steal the scroll from the first mark that
    exists`,
    async t => {
      await run(t, async () => {
        mark(page, page.locator('#missing'));
        mark(page, page.locator('#far'));
        const started = Date.now();
        const png = await readFile((await frame(page))!);
        assert.ok(Date.now() - started < 1500, 'an absent element is skipped, not waited for');
        const box = (await page.locator('#far').boundingBox())!;
        assert.ok(isYellow(await pixel(page, png, Math.round(box.x + 60), Math.round(box.y + 20))));
        await endFrames();
      });
    },
  );

  it('takes no frame when nothing marked is on the page', async t => {
    await run(t, async () => {
      mark(page, page.locator('#missing'));
      assert.equal(await frame(page), undefined);
      assert.deepEqual(await endFrames(), []);
    });
  });

  it(
    prose`
    collects several frames in order, flushes what is left at the end, and forgets stale marks`,
    async t => {
      await run(t, async () => {
        mark(page, page.locator('#a'));
        const one = await frame(page);
        mark(page, page.locator('#b')); // left for endFrames to capture
        const taken = await endFrames();
        assert.equal(taken.length, 2);
        assert.equal(taken[0], one);

        mark(page, page.locator('#a'));
        beginFrames(nextFrame); // a new call starts clean
        assert.deepEqual(await endFrames(), []);
      });
    },
  );
});
