import { readFileSync, writeFileSync } from 'node:fs';

import { runShaclValidation } from '@marinoscar/kvox-api/graph-rdf/shacl-runner';

// =============================================================================
// One SHACL validation in a utility process of its own (marinoscar/kvox#586)
// =============================================================================
//
// The graph import validates an uploaded RDF file with `rdf-validate-shacl` in
// a separate process. The package's default spawns `process.execPath` as Node,
// which the packaged app's RunAsNode fuse forbids, so the server passes
// `shacl.run` (`src/server/shacl-runner.ts`) and the main process forks this
// script through `node-script-host.ts`, like the migrations. A utility process
// has no stdin: the input and the report are files under `<userData>/tmp`.
// The validation itself is the package's `runShaclValidation`.
//
//   node shacl-validate.js <input.json> <report.json>
// =============================================================================

const [input, report] = process.argv.slice(2);
if (!input || !report) {
  console.error('shacl-validate: usage: shacl-validate <input.json> <report.json>');
  process.exit(2);
}

runShaclValidation(readFileSync(input, 'utf8'))
  .then((result) => writeFileSync(report, result))
  .catch((error: unknown) => {
    // The engine's message names its internals, never the file's content.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
