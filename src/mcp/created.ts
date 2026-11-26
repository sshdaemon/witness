import { app, type ActorName, type CleanupStep, type Kind, type Kinds } from '../app.js';
import type { ToolError } from '../errors.js';

export type { Kind, Kinds };

/**
 * Everything this session created, registered as soon as it exists so a failed run can still clean
 * it up.
 */
export class Created {
  private readonly lists = new Map<Kind, object[]>();

  private of<K extends Kind>(kind: K): Kinds[K][] {
    let list = this.lists.get(kind);
    if (!list) this.lists.set(kind, (list = []));
    return list as Kinds[K][];
  }

  /** Registers a record and returns it; later changes to it (a rename) are kept. */
  track<K extends Kind>(kind: K, item: Kinds[K]): Kinds[K] {
    this.of(kind).push(item);
    return item;
  }

  forget<K extends Kind>(kind: K, item: Kinds[K]) {
    const list = this.of(kind);
    const i = list.indexOf(item);
    if (i !== -1) list.splice(i, 1);
  }

  /** A copy, so a cleanup can forget records while it walks them. */
  list<K extends Kind>(kind: K): Kinds[K][] {
    return [...this.of(kind)] as Kinds[K][];
  }

  find<K extends Kind>(kind: K, match: (item: Kinds[K]) => boolean): Kinds[K] | undefined {
    return this.of(kind).find(match);
  }

  has<K extends Kind>(kind: K, match: (item: Kinds[K]) => boolean): boolean {
    return this.of(kind).some(match);
  }

  /**
   * The matching record, or the tool's own NOT_OWNED error: changes are limited to what this
   * session made.
   */
  require<K extends Kind>(
    kind: K,
    match: (item: Kinds[K]) => boolean,
    refuse: () => ToolError,
  ): Kinds[K] {
    // oxlint-disable-next-line unicorn/no-array-method-this-argument
    const found = this.find(kind, match);
    if (!found) throw refuse();
    return found;
  }

  count(kind: Kind): number {
    return this.of(kind).length;
  }

  /**
   * Records that still hold back the cleanups after them. A waiting entry whose line is hidden
   * cannot be removed through the page, so it is left behind instead of stranding the rest.
   */
  blocking(kind: Kind): number {
    return this.of(kind).filter(item => !('hidden' in item && item.hidden)).length;
  }

  /** Kinds with records still to clean up, in cleanup order. */
  pending(): (CleanupStep & { count: number })[] {
    return app()
      .cleanupOrder.filter(c => this.count(c.kind))
      .map(c => ({ ...c, count: this.count(c.kind) }));
  }
}

type CleanupResult = Record<string, unknown> & { failed: unknown[] };
type Cleanup = {
  actor: ActorName | undefined;
  run: (actor: ActorName | undefined) => Promise<CleanupResult>;
};
const cleanups = new Map<Kind, Cleanup>();

/**
 * A *_cleanup tool's body, so cleanup_all can run it too. actor is the account it acts as by
 * default (undefined when the records say).
 */
export function registerCleanup(kind: Kind, actor: ActorName | undefined, run: Cleanup['run']) {
  cleanups.set(kind, { actor, run });
}

export const cleanupFor = (kind: Kind) => cleanups.get(kind);

/** The cleanup-order sentence for the server instructions and descriptions. */
export const cleanupOrderText = (order: readonly CleanupStep[] = app().cleanupOrder) =>
  order.map(c => `${c.tool} (${c.what})`).join(', then ');
