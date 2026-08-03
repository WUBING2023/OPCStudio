#!/usr/bin/env node
// 单测用假 worker 进程(定稿 2.2 铁律:测试内禁止真实模型/真实 ACP 引擎)。模拟 `opc-worker run
// --executor acp` 的产出:在隔离 run 目录写齐 Runtime Contract 证据(result.json / events.jsonl /
// diagnostics.json / report.md),并向 stdout 打一行同 worker.ts ACP 分支的 JSON 摘要,然后退出。
// server 侧 acpWorkerBackend.runViaAcpWorker 用真 child_process spawn 起它,读它写的证据入账——由此
// 覆盖"经真实进程边界的文件证据契约",不打真模型、不花真钱。
//
// 用法:node fakeAcpWorker.mjs <isolatedRoot> <runId> <scenario>
//   done   —— 写 status=done 证据(默认):tokens 12/30、cost 0.001、一次 tool_call/result、report.md
//   failed —— 写 status=failed 证据 + diagnostics.engineFailures(模拟 worker 内 AcpTransportError → 触发降级)
import * as fs from "node:fs";
import * as path from "node:path";

const [, , isolatedRoot, runId, scenario = "done"] = process.argv;
const runDir = path.join(isolatedRoot, ".opc", "runs", runId);
fs.mkdirSync(runDir, { recursive: true });

const now = new Date().toISOString();
const write = (name, data) => fs.writeFileSync(path.join(runDir, name), typeof data === "string" ? data : JSON.stringify(data, null, 2), "utf-8");
const appendEvent = (type, agentId, payload) =>
  fs.appendFileSync(path.join(runDir, "events.jsonl"), JSON.stringify({ id: `${type}-${Math.random()}`, runId, timestamp: now, type, agentId, payload, v: 1 }) + "\n", "utf-8");

if (scenario === "failed") {
  write("result.json", {
    schemaVersion: "1", runId, status: "failed", startedAt: now, endedAt: now,
    agents: [{ agentId: "dev-1", role: "dev", framework: "claude-code", status: "failed", tokens: 0, costUsd: 0 }],
    artifacts: [], deferred: [], totalTokens: 0, totalCostUsd: 0,
  });
  write("diagnostics.json", {
    schemaVersion: "1", runId, engineFailures: [{ at: now, agentId: "dev-1", message: "ACP initialize 超时(30000ms)" }],
    providerFallbacks: [], rateLimitHits: [], permissionBlocks: [], notes: [],
  });
  appendEvent("run_started", undefined, { goal: "g", executor: "acp", engine: "claude-code" });
  appendEvent("error", "dev-1", { message: "ACP initialize 超时(30000ms)", restricted: false });
  appendEvent("run_finished", undefined, { status: "failed", executor: "acp", stopReason: "no_response" });
  process.stdout.write(JSON.stringify({ runId, agentId: "dev-1", status: "failed", stopReason: "no_response", executor: "acp", engine: "claude-code", runDir }) + "\n");
  process.exit(1);
}

// done
write("result.json", {
  schemaVersion: "1", runId, status: "done", startedAt: now, endedAt: now,
  agents: [{ agentId: "dev-1", role: "dev", framework: "claude-code", status: "idle", tokens: 42, costUsd: 0.001 }],
  artifacts: [], deferred: [], totalTokens: 42, totalCostUsd: 0.001,
});
write("report.md", "# Deliverable\n\nHello from ACP worker.");
appendEvent("run_started", undefined, { goal: "g", executor: "acp", engine: "claude-code" });
appendEvent("tool_call", "dev-1", { name: "Read README", args: { path: "README.md" }, toolCallId: "call_1", toolKind: "read", status: "pending" });
appendEvent("tool_result", "dev-1", { name: "call_1", result: "file contents here", status: "completed" });
appendEvent("model_call_finished", "dev-1", { tokens: 42, cost: 0, provider: "anthropic", model: "sonnet", promptTokens: 12, completionTokens: 30, stopReason: "end_turn" });
appendEvent("run_finished", undefined, { status: "done", executor: "acp", stopReason: "end_turn" });
write("tool_calls.jsonl", JSON.stringify({ ts: now, agentId: "dev-1", tool: "Read README", argsSummary: "{}", ok: true }) + "\n");
process.stdout.write(JSON.stringify({ runId, agentId: "dev-1", status: "done", stopReason: "end_turn", executor: "acp", engine: "claude-code", runDir }) + "\n");
process.exit(0);
