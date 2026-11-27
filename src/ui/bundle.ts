import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const CLIENT_DIR = resolve(import.meta.dirname, 'client');

// The newest change to the client's sources, so an edited file is bundled again on the next load.
const stamp = () =>
  String(
    Math.max(
      ...readdirSync(CLIENT_DIR, { recursive: true, encoding: 'utf8' }).map(
        f => statSync(resolve(CLIENT_DIR, f)).mtimeMs,
      ),
    ),
  );

let cached: { stamp: string; code: Promise<string> } | undefined;

/** The viewer's browser code: its TypeScript, Lit and the Shoelace parts it uses, as one module. */
export function clientBundle(): Promise<string> {
  const now = stamp();
  if (cached?.stamp !== now) {
    const code = build({
      entryPoints: [resolve(CLIENT_DIR, 'main.ts')],
      bundle: true,
      format: 'esm',
      target: 'es2022',
      write: false,
      legalComments: 'none',
      logLevel: 'silent',
    }).then(out => out.outputFiles[0]!.text);
    cached = { stamp: now, code };
    // A failed build is not kept, so the next load tries again.
    code.catch(() => {
      if (cached?.code === code) cached = undefined;
    });
  }
  return cached.code;
}
