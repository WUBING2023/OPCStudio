import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentFramework, AgentNodeConfig, ExecContext, ExecTask } from "@opc/shared";
import { runViaAcpWorker } from "./engines/acpWorkerBackend.js";

// 审计 P1-4 · 真实 provider 文件工具 canary(deep Doctor 用):让【真实 CLI/ACP provider】在隔离临时目录建一个 canary
// 文件,再由 Core 直接读盘核对文件是否真落盘 + 内容。直击"claude-code Write 在本机返回 ok=false"这类环境——
// 宿主 host.fs_canary 通过 ≠ provider 写盘可用,只有真跑一次真实 provider 才能证伪/证实。
//
// bounded + 安全默认:真实 CLI 调用有成本,故【env 门控】OPC_DOCTOR_PROVIDER_CANARY=1 才真跑;未启用 → 返回 null
// (Doctor 判 not_tested,并提示如何启用),绝不据宿主检查判 provider 可用。短超时、best-effort,任何异常/超时 → {ok:false}。
export function providerCanaryEnabled(): boolean {
  const v = (process.env.OPC_DOCTOR_PROVIDER_CANARY ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export async function providerToolCanaryReal(
  framework: string,
  nodeHint?: Pick<AgentNodeConfig, "provider" | "model" | "cliConfigDir">,
): Promise<{ ok: boolean; detail: string } | null> {
  if (!["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"].includes(framework)) return null; // 只对原生 CLI/ACP provider 有意义
  if (!providerCanaryEnabled()) return null; // 安全默认:未显式启用 → not_tested(不擅自发起付费 CLI 调用)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opc-provider-canary-"));
  const MARK = "OPC_CANARY_OK";
  try {
    const canaryNode = {
      id: "doctor-canary", name: "Doctor Canary", role: "dev", framework,
      provider: nodeHint?.provider ?? "anthropic", model: nodeHint?.model ?? "sonnet",
      ...(nodeHint?.cliConfigDir ? { cliConfigDir: nodeHint.cliConfigDir } : {}),
      childrenIds: [], status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
      costUsd: 0, editable: true, deletable: true, enabled: true,
    } as AgentNodeConfig;
    const ctx = {
      runId: "doctor-canary", projectRoot: dir, workdir: dir,
      emit: () => { /* 静默 */ }, budget: { maxTokensPerTask: 512 }, taskTimeoutMs: 45_000,
    } as unknown as ExecContext;
    const task: ExecTask = {
      taskId: "canary",
      goal: `Create a file named canary.txt whose exact content is ${MARK}. Use your write-file tool. Do nothing else.`,
      systemPrompt: "You are a file-writing canary. Call the write-file tool to create the requested file, then stop.",
      maxTokens: 512,
    };
    const res = await runViaAcpWorker(framework as AgentFramework, canaryNode, task, ctx, {
      fallback: async () => ({ content: "", fileChanges: [], tokens: { prompt: 0, completion: 0, total: 0 }, cost: 0, latencyMs: 0, status: "restricted", error: "canary fallback(legacy CLI)" }),
    });
    // Core 直接读盘核对(不信 worker 自报):canary.txt 是否真在隔离目录 + 内容含标记。
    const landed = (() => { try { return fs.readFileSync(path.join(dir, "canary.txt"), "utf-8").includes(MARK); } catch { return false; } })();
    return landed
      ? { ok: true, detail: `真实 ${framework} 在隔离目录成功写出 canary.txt 并核对内容(provider 文件工具可用)` }
      : { ok: false, detail: `真实 ${framework} 未能落盘 canary.txt(status=${res.status}${res.error ? "," + String(res.error).slice(0, 80) : ""})——provider 文件工具不可用(如 claude-code Write ok=false)` };
  } catch (e: any) {
    return { ok: false, detail: `真实 provider canary 异常:${e?.message ?? String(e)}` };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
}
