#!/usr/bin/env node
import {
  NATIVE_EXECUTION_SCHEMA_VERSION,
  type NativeRunResult,
} from "@opc/shared";
import { executeCodexNativeRun } from "./nativeRun.js";
import { executeClaudeNativeRun } from "./claudeAgentSdkRun.js";
import { parseNativeRunnerRequest } from "./runnerContract.js";

async function readStdin(limit = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("native request exceeds 1 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function invalid(message: string): NativeRunResult {
  return {
    schemaVersion: NATIVE_EXECUTION_SCHEMA_VERSION,
    requestId: "invalid",
    runId: "invalid",
    status: "blocked",
    failureKind: "invalid_response",
    message,
    content: "",
    tokens: { prompt: 0, completion: 0, total: 0 },
    events: [],
  };
}

let result: NativeRunResult;
try {
  const raw = JSON.parse(await readStdin()) as unknown;
  const request = parseNativeRunnerRequest(raw);
  result = request.host === "claude-code"
    ? await executeClaudeNativeRun(request)
    : await executeCodexNativeRun(request);
} catch (error) {
  result = invalid(error instanceof Error ? error.message : String(error));
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.status === "done" ? 0 : result.status === "blocked" ? 4 : 1;
