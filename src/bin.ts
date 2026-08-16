#!/usr/bin/env node
import { run } from './cli/main.js';

const exitCode = run(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  cwd: process.cwd(),
});

process.exitCode = exitCode;
