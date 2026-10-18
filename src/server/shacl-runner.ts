import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ShaclRun } from '@marinoscar/kvox-api/graph-rdf/shacl-runner';

import { workingDirectoryOf, type NodeScriptRunner } from './database.js';

// =============================================================================
// `GraphRdfModule.forRoot({ shacl: { run } })` on Desktop (marinoscar/kvox#586)
// =============================================================================
//
// Each validation is a utility process the main process forks
// (`src/main/shacl-validate.ts`, through the same `run-node` request the
// migrations use): the input the package hands over is written to a scratch
// file, the script writes the report beside it, and both are removed after.
// The package keeps its timeout around this call. A process still running
// when it fires is left to finish (a utility process cannot be killed from
// here); its result is ignored and its files are swept with `tmp/` at the
// next start.
// =============================================================================

/** The `shacl.run` of the graph-rdf slice. */
export function utilityProcessShaclRun(options: { appRoot: string; scriptPath: string; tmpDir: string; run: NodeScriptRunner }): ShaclRun {
  return async (input) => {
    const dir = join(options.tmpDir, 'shacl');
    await mkdir(dir, { recursive: true });
    const id = randomUUID();
    const inputPath = join(dir, `${id}.input.json`);
    const reportPath = join(dir, `${id}.report.json`);
    try {
      await writeFile(inputPath, input);
      const { code, output } = await options.run({
        script: options.scriptPath,
        args: [inputPath, reportPath],
        cwd: workingDirectoryOf(options.appRoot),
        env: {},
      });
      if (code !== 0) throw new Error(`exit ${code}: ${output.slice(0, 500)}`);
      return await readFile(reportPath, 'utf8');
    } finally {
      await rm(inputPath, { force: true });
      await rm(reportPath, { force: true });
    }
  };
}
