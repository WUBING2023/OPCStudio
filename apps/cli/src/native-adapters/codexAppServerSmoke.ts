import { runCodexAppServerSmoke } from "./codexAppServer.js";

runCodexAppServerSmoke().then(
  (result) => process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`),
  (error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  },
);
