#!/usr/bin/env node
import { run } from "./run.js";

const result = await run(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
process.exitCode = result.exitCode;

// On Ctrl-C or a service stop, save sessions and flush the log before exiting.
const { close } = result;
if (close) {
  let stopping = false;
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.on(signal, () => {
      if (stopping) process.exit(code);
      stopping = true;
      const deadline = setTimeout(() => process.exit(code), 3000);
      deadline.unref();
      close().finally(() => process.exit(code));
    });
  }
}
