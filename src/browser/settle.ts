import type { Page } from 'playwright';

// Waits for load, then for the network to go quiet. Dev servers may never go fully idle, so the
// quiet wait is capped.
export async function settle(page: Page, quietMs = 5000): Promise<void> {
  await page.waitForLoadState('load').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: quietMs }).catch(() => {});
}

/**
 * Reads until `times` reads in a row come back the same (and `ready` holds for them), `every` ms
 * apart, at most `tries` reads and, with `withinMs`, no longer than that. Returns the last read and
 * whether it settled, so the caller decides if running out of tries is an error.
 */
export async function untilStable<T>(
  page: Pick<Page, 'waitForTimeout'>,
  read: () => Promise<T>,
  opts: {
    times: number;
    every: number;
    tries: number;
    withinMs?: number;
    ready?: (value: T) => boolean;
  },
): Promise<{ value: T; settled: boolean }> {
  let last: string | undefined;
  let stable = 0;
  let value!: T;
  const deadline = opts.withinMs === undefined ? Infinity : Date.now() + opts.withinMs;
  for (let i = 0; i < opts.tries && (i === 0 || Date.now() < deadline); i++) {
    value = await read();
    const key = JSON.stringify(value);
    stable = key === last && (opts.ready?.(value) ?? true) ? stable + 1 : 0;
    last = key;
    if (stable >= opts.times) return { value, settled: true };
    if (i < opts.tries - 1) await page.waitForTimeout(opts.every);
  }
  return { value, settled: false };
}

// Reads the accessibility snapshot once it has stopped changing, so a half-rendered page is never
// returned.
export async function stableSnapshot(page: Page): Promise<string> {
  return (
    await untilStable(page, () => page.locator('body').ariaSnapshot(), {
      times: 2,
      every: 400,
      tries: Infinity,
      withinMs: 8000,
    })
  ).value;
}
