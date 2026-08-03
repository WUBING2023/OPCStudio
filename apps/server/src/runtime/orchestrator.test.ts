/**
 * Orchestrator E2E 冒烟(P1#14):mock provider 走 HermesEngine 的 mock 短路 → callModel 注册的
 * mock handler,零密钥零外呼跑通 initOrchestrator → runAgent 全链(状态机/计量/事件)。
 * 运行: npm run e2e(apps/server)或 npx tsx apps/server/src/runtime/orchestrator.test.ts
 * 被 vitest 显式排除(vitest.config.ts):它做真实盘/进程级初始化,是手动/CI 冒烟,不是单测。
 *
 * 注:旧版此脚本断言"OPC 自带 text tool-loop 会真的写出 hello.txt"——那套自有工具循环已被
 * 刻意移除(工具在引擎侧:Hermes/CLI 自带),相关断言已随架构更新删除。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { initOrchestrator, runAgent, getAgents } from "./orchestrator.js";
import { setProjectRoot } from "../security/pathGuard.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.error(`  FAIL - ${name}`); }
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opc-test-"));
  console.log(`Test root: ${tmpDir}`);

  try {
    initOrchestrator(tmpDir);
    setProjectRoot(tmpDir);
    const agents = getAgents();
    check("默认 agents 已加载(≥3)", agents.length >= 3);

    const devAgent = agents.find(a => a.id === "backend-engineer") ?? agents.find(a => a.role !== "ceo");
    if (!devAgent) { console.error("找不到任何非 CEO agent"); process.exit(1); }

    // mock provider:HermesEngine 短路 → callModel mock handler,无密钥无外呼
    devAgent.provider = "mock";
    devAgent.model = "mock-model";

    console.log("\n--- Test 1: runAgent 全链(mock) ---");
    const result = await runAgent(
      devAgent,
      "You are a developer agent.",
      "create a file named hello.txt with content 'hello world'",
    );
    console.log(`Agent response: ${result.slice(0, 160)}`);
    check("响应非空", result.length > 0);
    check("响应来自 mock handler", result.includes("[MOCK"));
    check("执行后 agent 状态回 idle", devAgent.status === "idle");
    check("token 计量已记录(>0)", devAgent.tokenUsage.total > 0);

    console.log("\n--- Test 2: 二次调用(状态机可重入) ---");
    const before = devAgent.tokenUsage.total;
    const result2 = await runAgent(devAgent, "You are a developer agent.", "list the files in the current directory");
    console.log(`Agent response: ${result2.slice(0, 160)}`);
    check("二次调用完成", result2.length > 0);
    check("token 累计递增", devAgent.tokenUsage.total > before);
    check("状态再次回 idle", devAgent.status === "idle");

  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }
    console.log(`\nCleaned up: ${tmpDir}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
