import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentNodeConfig } from "@opc/shared";
import { initEngineRouter } from "@opc/server/src/runtime/engineRouter.js";
import { saveAgents } from "@opc/server/src/storage/projectStore.js";
import { runAcpWorkerTask } from "../acp/acpWorkerRunner.js";
import { executeCodexNativeRun } from "./nativeRun.js";

const MARKER = "OPC_CROSS_PATH_OK";
const PROMPT = `Reply with exactly ${MARKER} and nothing else. Do not use tools and do not modify files.`;

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main(): Promise<void> {
  const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
  const evidenceRoot = path.join(repositoryRoot, "evidence", "ecosystem-live", `cross-path-${timestamp()}`);
  const workspace = path.join(evidenceRoot, "workspace");
  fs.mkdirSync(path.join(workspace, ".opc"), { recursive: true });
  const agent: AgentNodeConfig = {
    id: "cross-path-codex",
    name: "Cross Path Codex",
    role: "worker",
    companyId: "cross-path-company",
    framework: "codex",
    provider: "openai",
    model: "gpt-5.5",
    status: "idle",
    enabled: true,
    editable: true,
    deletable: true,
    childrenIds: [],
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    costUsd: null,
  };
  saveAgents(workspace, [agent]);

  initEngineRouter();
  const acp = await runAcpWorkerTask({
    taskId: "cross-path-task",
    runId: "cross-path-acp",
    goal: PROMPT,
    agentId: "cross-path-codex",
    companyId: "cross-path-company",
  }, { projectRoot: workspace, engine: "codex" });

  const native = await executeCodexNativeRun({
    schemaVersion: "1",
    requestId: "cross-path-native",
    runId: "cross-path-native",
    taskId: "cross-path-task",
    agentId: "cross-path-codex",
    host: "codex",
    operation: "start",
    cwd: workspace,
    prompt: PROMPT,
    timeoutMs: 120_000,
    approvalPolicy: "never",
    sandbox: "read-only",
    allowedTools: [],
  });

  const summary = {
    schemaVersion: "1",
    generatedAt: new Date().toISOString(),
    prompt: PROMPT,
    marker: MARKER,
    acp: {
      status: acp.result.status,
      content: acp.result.content,
      markerPresent: acp.result.content.includes(MARKER),
      tokens: acp.result.tokens,
      costUsd: acp.result.cost,
      stopReason: acp.stopReason,
      runDir: path.relative(evidenceRoot, acp.runDir).replaceAll(path.sep, "/"),
    },
    native: {
      status: native.status,
      content: native.content,
      markerPresent: native.content.includes(MARKER),
      tokens: native.tokens,
      costUsd: native.costUsd ?? null,
      session: native.session,
      eventMethods: native.events.map((event) => {
        const payload = event.payload as { method?: unknown };
        return typeof payload?.method === "string" ? payload.method : event.type;
      }),
    },
  };
  const ok = summary.acp.status === "done"
    && summary.acp.markerPresent
    && summary.acp.tokens.total > 0
    && summary.acp.costUsd === null
    && summary.native.status === "done"
    && summary.native.markerPresent
    && summary.native.tokens.total > 0
    && summary.native.costUsd === null;
  fs.writeFileSync(path.join(evidenceRoot, "summary.json"), JSON.stringify({ ok, ...summary }, null, 2));
  process.stdout.write(`${JSON.stringify({ ok, evidenceRoot, ...summary })}\n`);
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});