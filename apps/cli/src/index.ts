#!/usr/bin/env node
import { executeCli } from "./headless/program.js";

const controller = new AbortController();
const interrupt = () => controller.abort();
process.once("SIGINT", interrupt);

try {
  process.exitCode = await executeCli(process.argv.slice(2), { signal: controller.signal });
} finally {
  process.removeListener("SIGINT", interrupt);
}
