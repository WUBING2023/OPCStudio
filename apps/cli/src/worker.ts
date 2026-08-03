#!/usr/bin/env node
// B3 · opc-worker CLI:执行单个 task.json(WorkerTaskContract),产出与 HTTP 路径同构的 run 目录
// 证据文件(task.json/result.json/events.jsonl/worker.config.json)。CEO/Lead/Worker/Reviewer 四种
// 角色共用这一个入口——见 workerRunner.ts 的注释。
import { program } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { WorkerTaskContractSchema } from "@opc/shared";
import { initEngineRouter } from "@opc/server/src/runtime/engineRouter.js";
import { runWorkerTask, WorkerTaskAgentResolutionError } from "./workerRunner.js";
import { runAcpWorkerTask } from "./acp/acpWorkerRunner.js";
import { isAcpEngineId, ACP_ENGINE_IDS } from "./acp/engineRegistry.js";
import { runChatServe } from "./acp/chatServe.js";

// Windows/libuv 退出稳定:直接 process.exit() 可能在异步句柄尚未完全关闭时触发
// UV_HANDLE_CLOSING 断言崩溃(真实 HTTP 调用后尤其明显)。改为设置 exitCode 让事件循环
// 自然收尾;若因遗留句柄挂起,则由 setTimeout 兜底强制退出。
function exitWithCode(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 500).unref();
}

program
  .name("opc-worker")
  .description("OPC Studio worker runner —— 执行单个 task.json(CEO/Lead/Worker/Reviewer 共用同一 Runner)")
  .version("0.1.0");

program
  .command("run")
  .description("执行一个 task.json,产出与 HTTP 路径同构的 run 目录证据文件")
  .requiredOption("--task <path>", "task.json 文件路径(WorkerTaskContract: taskId/goal + agentId 或 role + 可选 companyId/maxTokens/runId)")
  .option("--project-root <dir>", "项目根目录(须含 .opc/);缺省用当前工作目录,但会打印出实际解析值")
  .option("--executor <kind>", "执行器:default(旧 spawn 路径,保底 fallback)或 acp(自研 ACP 客户端)", "default")
  .option("--engine <name>", `ACP 引擎(--executor acp 时必填):${ACP_ENGINE_IDS.join(" | ")}`)
  .action(async (opts: { task: string; projectRoot?: string; executor: string; engine?: string }) => {
    const taskPath = path.resolve(opts.task);
    if (!fs.existsSync(taskPath)) {
      console.error(`[opc-worker] task 文件不存在: ${taskPath}`);
      process.exit(1);
    }

    let rawTask: unknown;
    try {
      rawTask = JSON.parse(fs.readFileSync(taskPath, "utf-8"));
    } catch (e: unknown) {
      console.error(`[opc-worker] task.json 不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }

    const parsed = WorkerTaskContractSchema.safeParse(rawTask);
    if (!parsed.success) {
      console.error("[opc-worker] task.json 未通过契约校验:");
      for (const issue of parsed.error.issues) {
        console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
      }
      process.exit(1);
    }

    // 已知陷阱(projectRoot 静默落到 process.cwd() → 起错目录、看似正常实则 0-agent 空跑):这里是
    // 全链路唯一允许出现 process.cwd() 的地方——显式解析、显式打印;之后 workerRunner.ts 及其调用的
    // server 模块一律只认这个已解析好的 projectRoot,谁都不再自己去问 cwd。
    const projectRoot = opts.projectRoot ? path.resolve(opts.projectRoot) : process.cwd();
    console.error(`[opc-worker] projectRoot = ${projectRoot}`);

    const agentsPath = path.join(projectRoot, ".opc", "agents.json");
    if (!fs.existsSync(path.join(projectRoot, ".opc"))) {
      console.error(`[opc-worker] 错误: "${projectRoot}" 下没有 .opc 目录 —— 很可能 --project-root 传错了(或没传、当前工作目录不是项目根)。`);
      console.error("[opc-worker] 已知陷阱:projectRoot 猜错会静默产出空跑,这里选择硬失败而不是继续。");
      process.exit(1);
    }
    if (!fs.existsSync(agentsPath)) {
      console.error(`[opc-worker] 错误: "${agentsPath}" 不存在 —— 该 projectRoot 下没有 agent 名册,无法解析执行者。`);
      process.exit(1);
    }

    const executor = opts.executor ?? "default";
    if (executor !== "default" && executor !== "acp") {
      console.error(`[opc-worker] 未知 --executor "${executor}"(仅支持 default | acp)`);
      process.exit(1);
    }

    initEngineRouter();
    try {
      // ── ACP 执行路径(相1:自研 worker CLI 作为唯一 ACP client)────────────────────────
      if (executor === "acp") {
        const engine = opts.engine ?? "";
        if (!isAcpEngineId(engine)) {
          console.error(`[opc-worker] --executor acp 需要 --engine(${ACP_ENGINE_IDS.join(" | ")});收到 "${engine || "(空)"}"`);
          process.exit(1);
        }
        const outcome = await runAcpWorkerTask(parsed.data, { projectRoot, engine });
        console.log(JSON.stringify({
          runId: outcome.runId,
          agentId: outcome.agent.id,
          status: outcome.result.status,
          stopReason: outcome.stopReason,
          executor: "acp",
          engine,
          runDir: outcome.runDir,
        }, null, 2));
        exitWithCode(outcome.result.status === "done" ? 0 : 1);
      }

      // ── 旧 spawn 路径(保底 fallback,原封不动)──────────────────────────────────────
      const outcome = await runWorkerTask(parsed.data, { projectRoot });
      console.log(JSON.stringify({
        runId: outcome.runId,
        agentId: outcome.agent.id,
        status: outcome.result.status,
        runDir: outcome.runDir,
      }, null, 2));
      exitWithCode(outcome.result.status === "done" ? 0 : 1);
    } catch (e: unknown) {
      if (e instanceof WorkerTaskAgentResolutionError) {
        console.error(`[opc-worker] ${e.message}`);
      } else {
        console.error(`[opc-worker] 执行失败: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      }
      exitWithCode(1);
    }
  });

// 订阅对话会话池 · worker 侧长驻服务模式。启动即建一条 ACP 会话,循环从 stdin 读 JSONL 请求经既有会话发
// session/prompt、向 stdout 写 JSONL 响应;收到 stdin EOF 优雅退出并按 PID 树杀干净 adapter。由 server 端
// subscriptionChatPool 池化调用(每引擎至多 1 个常驻 worker)。握手失败以非零码退出,server 池等待 ready 超时后降级。
program
  .command("chat-serve")
  .description("长驻 ACP 对话服务:建一条会话后循环处理 stdin JSONL 请求(供 server 端订阅会话池池化)")
  .requiredOption("--engine <name>", `ACP 引擎:${ACP_ENGINE_IDS.join(" | ")}`)
  .action(async (opts: { engine?: string }) => {
    const engine = opts.engine ?? "";
    if (!isAcpEngineId(engine)) {
      console.error(`[opc-worker] chat-serve 需要 --engine(${ACP_ENGINE_IDS.join(" | ")});收到 "${engine || "(空)"}"`);
      process.exit(1);
    }
    initEngineRouter();
    try {
      await runChatServe({ engine, input: process.stdin, output: process.stdout });
      process.exit(0); // stdin EOF → 会话已清理,正常退出
    } catch (e: unknown) {
      // 建会话/握手失败:非零码退出,server 池等待 ready 超时后降级到一次性引擎链。
      console.error(`[opc-worker] chat-serve 启动失败: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      process.exit(1);
    }
  });

program.parse();
