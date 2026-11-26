// Numbers `count` runs of one ticket from its own process, as a second witness server would, and
// prints the numbers it got.
// Usage: tsx number-runs.ts <results dir> <ticket> <run id prefix> <count>
const [dir, ticket, prefix, count] = process.argv.slice(2);
process.env.WITNESS_RESULTS_DIR = dir;

const { store } = await import('../../src/mcp/store.js');
const { inWriteTransaction, numberRun } = await import('../../src/mcp/cases.js');

const got: number[] = [];
for (let i = 0; i < Number(count); i++) {
  got.push(
    inWriteTransaction(() => {
      const id = `${prefix}-${i}`;
      store()
        .prepare(
          `
            INSERT INTO runs (id, env, run_tag, started_at)
            VALUES (?, 'local', 't', '2026-11-04T00:00:00Z')
          `,
        )
        .run(id);
      return numberRun(id, ticket!).runNumber;
    }),
  );
}
console.log(JSON.stringify(got));
