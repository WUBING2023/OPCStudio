#!/usr/bin/env node
import * as path from "node:path";
import { writePluginDistributions } from "./distribution.js";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
if (!output || output.startsWith("--")) {
  process.stderr.write("Usage: tsx apps/cli/src/plugins/build.ts --output <integration-root>\n");
  process.exitCode = 2;
} else {
  try {
    const resolved = path.resolve(output);
    writePluginDistributions(resolved);
    process.stdout.write(JSON.stringify({ ok: true, output: resolved, platforms: ["codex", "claude"] }) + "\n");
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}
