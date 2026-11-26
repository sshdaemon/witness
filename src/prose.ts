/**
 * A long text written over several lines in code: each run of whitespace in the literal parts (the
 * line breaks and indentation) becomes one space, and the text's own ends are trimmed. Values are
 * kept as they are.
 *
 *   description: prose`
 *     Reads the orders page and returns
 *     the first page of rows.`,
 */
export function prose(strings: TemplateStringsArray, ...values: unknown[]): string {
  const last = strings.length - 1;
  let out = '';
  strings.forEach((text, i) => {
    // Only the literal ends are trimmed, so a value at either end comes through as it is.
    let part = text.replaceAll(/\s+/g, ' ');
    if (i === 0) part = part.trimStart();
    if (i === last) part = part.trimEnd();
    out += part;
    if (i < values.length) out += String(values[i]);
  });
  return out;
}
