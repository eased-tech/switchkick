#!/usr/bin/env node
import { run } from "./run.js";

const result = await run(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
process.exitCode = result.exitCode;
