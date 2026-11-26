/**
 * When the wait for verdicts may end. It counts from the moment every lane is waiting or done, so a
 * lane that gets there first does not time out while the session still waits for the slowest.
 */
export function laneClock(lanes: number, now: () => number = Date.now) {
  const ready = new Set<number>();
  let allReadyAt: number | undefined;
  return {
    /** The lane is waiting for verdicts, or has ended. */
    markReady(index: number) {
      ready.add(index);
      if (ready.size === lanes) allReadyAt ??= now();
    },
    /** Whether a wait that began at since has gone minutes past the moment every lane was ready. */
    over(since: number, minutes: number) {
      return allReadyAt !== undefined && now() > Math.max(since, allReadyAt) + minutes * 60_000;
    },
  };
}

/**
 * Runs every lane at once. A lane that throws (its server did not start, say) is reported at once
 * and marked ready, so the others neither wait for it nor are cut short before their cleanup.
 */
export function runLanes<T>(
  count: number,
  run: (index: number) => Promise<T>,
  hooks: { failed: (index: number, error: unknown) => void; ended: (index: number) => void },
): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(
    Array.from({ length: count }, async (_, index) => {
      try {
        return await run(index);
      } catch (e) {
        hooks.failed(index, e);
        throw e;
      } finally {
        hooks.ended(index);
      }
    }),
  );
}

/**
 * Reads new versions of the verdict file for one lane. A version is new when its text or its write
 * time changed, so the same "final" written again still counts. A "final" written before this lane
 * began waiting was meant for the lanes already waiting: its verdicts apply, the wait goes on.
 */
export function verdictVersions<V extends { final?: boolean }>() {
  let last = '';
  let waitingSince: number | undefined;
  return {
    /** Marks the start of this lane's wait; later calls keep the first mark. */
    startWaiting(now: number) {
      waitingSince ??= now;
    },
    /** The version in the file, if it is new and complete; undefined otherwise. */
    take(file: { text: string; mtimeMs: number } | undefined): V | undefined {
      if (!file) return undefined;
      const key = `${file.mtimeMs}:${file.text}`;
      if (key === last) return undefined;
      let parsed: V;
      try {
        parsed = JSON.parse(file.text) as V;
      } catch {
        return undefined; // half written: read it again on the next turn
      }
      last = key;
      const early = waitingSince !== undefined && file.mtimeMs < waitingSince;
      return early ? { ...parsed, final: false } : parsed;
    },
  };
}
