// A slug such as "old-flow-checkout" is how older runs named their use case; show it as words.
const humanise = (slug: string) =>
  /^[a-z0-9]+(-[a-z0-9]+)+$/.test(slug)
    ? slug.replaceAll('-', ' ').replace(/^./, c => c.toUpperCase())
    : slug;

/**
 * How a topic is shown: the text the session gave, or an older run's use-case slug made readable.
 */
export function topicTitle(topic: string | null | undefined): string {
  return topic?.trim() ? humanise(topic) : 'Untitled runs';
}

/** The one definition of "the same topic": spacing and letter case (any script) do not matter. */
export const topicKey = (topic: string | null | undefined) => (topic ?? '').trim().toLowerCase();
