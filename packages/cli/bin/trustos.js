#!/usr/bin/env node
/**
 * `trustos` entry point.
 *
 * Deliberately a thin shim: it resolves the compiled program and hands over.
 * Keeping logic out of the bin script means the CLI can be exercised in tests
 * without spawning a process.
 */
'use strict';

const { run } = require('../dist/index.js');

run(process.argv).catch((error) => {
  // A failure this far out means the program itself could not start.
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
