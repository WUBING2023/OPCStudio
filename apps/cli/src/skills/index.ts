#!/usr/bin/env node
import * as path from "node:path";
import { exportSharedSkills } from "./exporter.js";

function outputArgument(argumentsValue: string[]): string {
  const index = argumentsValue.indexOf("--output");
  const value = index >= 0 ? argumentsValue[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error("Usage: opc-skill-export --output <new-directory>");
  return path.resolve(value);
}

try {
  const result = exportSharedSkills(outputArgument(process.argv.slice(2)));
  process.stdout.write(JSON.stringify({ ok: true, data: result }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: {
      code: "skill_export_failed",
      message: error instanceof Error ? error.message : String(error),
      details: {},
      retryable: false,
    },
  }) + "\n");
  process.exitCode = 1;
}
