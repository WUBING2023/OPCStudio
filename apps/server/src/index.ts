import express from "express";
import { registerGoalRoutes } from "./routes/goalRoutes.js";
import { registerLoopRoutes } from "./routes/loopRoutes.js";
import { registerAutomationStarters, startAutomationScheduler } from "./runtime/harness.js";
import { startGoal, isGoalInFlight } from "./runtime/goalRunner.js";
import { startLoop, isLoopInFlight } from "./runtime/loopRunner.js";
import cors from "cors";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import * as nodePath from "node:path";
import * as nodeFs from "node:fs";
import { setModelGatewayRoot } from "./runtime/modelGateway.js";
import { getAgents, initOrchestrator, updateAgent } from "./runtime/orchestrator.js";
import { syncProvidersFromStore } from "./runtime/providerRegistry.js";
import { setToolsProjectRoot } from "./runtime/tools.js";
import { initEngineRouter } from "./runtime/engineRouter.js";
import { loadCommunityIndex } from "./storage/communityStore.js";
import { syncBuiltinContent } from "./communitySeed.js";
import { seedDefaultMcpServers } from "./seed/mcpContent.js";
import { loadPricing } from "./storage/pricingStore.js";
import { initProviderHealth } from "./runtime/providerHealth.js";
import { setProjectRoot } from "./security/pathGuard.js";
import { getSessionToken, sessionAuthMiddleware, injectSessionTokenMeta, persistSessionTokenFile } from "./security/sessionToken.js";
import { setEventPersistRoot, subscribe as subscribeEvents } from "./runtime/eventBus.js";
import { setUsageRoot, recordUsage } from "./storage/usageStore.js";
import { appendLedger, appendRunEndWithReconcile, deriveCostSource } from "./storage/sqlite/ledgerStore.js";
import { ensureStoreMeta } from "./storage/metaStore.js";
import { initA2ASdk } from "./runtime/a2aSdk.js";
import { reconcileRunningTasksOnStartup, reconcileRunningTaskGraphsOnStartup } from "./runtime/startupReconcile.js";
import { reclassifyLegacyRunsOnStartup } from "./runtime/legacyRunReclassify.js";
import { migrateLegacyPersonaSkills } from "./storage/skillStore.js";
import { isSqliteBackend } from "./storage/backend.js";
import { migrateJsonToSqlite } from "./storage/sqlite/migrateJsonToSqlite.js";
import { goldenCompare } from "./storage/sqlite/goldenCompare.js";
import { scheduleMemoryCurator } from "./runtime/memoryCurator.js";
import { rebuildLayeredMemorySearchIndex } from "./storage/layeredMemory.js";

import { register as registerConfigRoutes } from "./routes/configRoutes.js";
import { register as registerFileRoutes } from "./routes/fileRoutes.js";
import { register as registerA2ARoutes } from "./routes/a2aRoutes.js";
import { register as registerWebRoutes } from "./routes/webRoutes.js";
import { register as registerAgentRoutes } from "./routes/agentRoutes.js";
import { register as registerRunRoutes } from "./routes/runRoutes.js";
import { register as registerConflictRoutes } from "./routes/conflictRoutes.js";
import { register as registerCommunityRoutes } from "./routes/communityRoutes.js";
import { register as registerEventRoutes } from "./routes/eventRoutes.js";
import { register as registerPricingRoutes } from "./routes/pricingRoutes.js";
import { register as registerProviderRoutes } from "./routes/providerRoutes.js";
import { register as registerSkillRoutes } from "./routes/skillRoutes.js";
import { register as registerMcpRoutes } from "./routes/mcpRoutes.js";
import { register as registerChatRoutes } from "./routes/chatRoutes.js";
import { register as registerFrameworkRoutes } from "./routes/frameworkRoutes.js";
import { register as registerModelCatalogRoutes } from "./routes/modelCatalogRoutes.js";
import { register as registerAccountRoutes } from "./routes/accountRoutes.js";
import { register as registerMemoryRoutes } from "./routes/memoryRoutes.js";
import { register as registerCompanyRoutes } from "./routes/companyRoutes.js";
import { register as registerArchitectRoutes } from "./routes/architectRoutes.js";
import { register as registerCompanyArchitectRoutes } from "./routes/companyArchitectRoutes.js";
import { register as registerCostRoutes } from "./routes/costRoutes.js";
import { register as registerGithubRoutes } from "./routes/githubRoutes.js";
import { register as registerSetupRoutes } from "./routes/setupRoutes.js";
import { register as registerMissionRoutes } from "./routes/missionRoutes.js";
import { register as registerTaskRoutes } from "./routes/taskRoutes.js";
import { register as registerCeoRoutes } from "./routes/ceoRoutes.js";
import { register as registerDoctorRoutes } from "./routes/doctorRoutes.js";
import { register as registerGovernanceRoutes } from "./routes/governanceRoutes.js";
import { register as registerOnboardingRoutes } from "./routes/onboardingRoutes.js";
import { register as registerArchiveRoutes } from "./routes/archiveRoutes.js";

function readPackageName(dir: string): string {
  try {
    const pj = nodePath.join(dir, "package.json");
    if (!nodeFs.existsSync(pj)) return "";
    const name = JSON.parse(nodeFs.readFileSync(pj, "utf-8"))?.name ?? "";
    return typeof name === "string" ? name : "";
  } catch {
    return "";
  }
}

function isOpcPackageDir(abs: string): boolean {
  const base = nodePath.basename(abs).toLowerCase();
  const parent = nodePath.basename(nodePath.dirname(abs)).toLowerCase();
  const looksLikeSubPkg = parent === "apps" && ["server", "web", "cli"].includes(base);
  return looksLikeSubPkg || /^@opc\/(server|web|cli|shared)$/.test(readPackageName(abs));
}

function looksLikeOpcWorkspaceRoot(abs: string): boolean {
  const hasWorkspace = nodeFs.existsSync(nodePath.join(abs, "pnpm-workspace.yaml"));
  const hasServerPkg = nodeFs.existsSync(nodePath.join(abs, "apps", "server", "package.json"));
  const rootPackageName = readPackageName(abs);
  return hasServerPkg && (hasWorkspace || rootPackageName === "opc-studio" || nodeFs.existsSync(nodePath.join(abs, ".opc")));
}

function findContainingOpcWorkspace(start: string): string | null {
  let cur = nodePath.resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (looksLikeOpcWorkspaceRoot(cur)) return cur;
    const parent = nodePath.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

export function resolveCliProjectRoot(cwd = process.cwd(), envRoot = process.env.OPC_PROJECT_ROOT): string {
  if (envRoot && envRoot.trim()) return nodePath.resolve(envRoot);
  const abs = nodePath.resolve(cwd);
  if (isOpcPackageDir(abs)) return findContainingOpcWorkspace(abs) ?? abs;
  return findContainingOpcWorkspace(abs) ?? abs;
}

function isCliEntry(): boolean {
  const entry = process.argv[1] ? nodePath.resolve(process.argv[1]) : "";
  return entry === nodePath.resolve(fileURLToPath(import.meta.url));
}

// 启动根目录校验:防 projectRoot 指错(尤其从 apps/server 启动 → process.cwd() 成 apps/server → 跑在残缺 .opc,
// 制造"系统正常但结果诡异"的假故障)。硬拦 apps/* 子包目录(永不合法);缺关键 .opc 文件/agent 数异常 → 强警告。
function validateProjectRoot(root: string): void {
  const abs = nodePath.resolve(root);

  // 1) Hard block package subdirectories that are not valid OPC project roots.
  if (isOpcPackageDir(abs)) {
    console.error("\n========================================================================");
    console.error(`[OPC] 致命:projectRoot 指向了子包目录 "${abs}"(看起来是 apps/* 内部)。`);
    console.error("[OPC] 这会让服务器跑在残缺的 .opc(只有部分供应商/agent),制造'系统正常但结果诡异'的假故障。");
    console.error("[OPC] 修复:从仓库根启动,或显式设置 OPC_PROJECT_ROOT 指向真实项目根。");
    console.error('[OPC]   例:  $env:OPC_PROJECT_ROOT="M:\\OPC\\projects\\OPCstudio"; pnpm --filter @opc/server dev');
    console.error("========================================================================\n");
    process.exit(1);
  }

  // 2) 强警告:缺关键 .opc 文件 / agent 数异常(可能是错根,也可能是全新项目)。
  const opcDir = nodePath.join(abs, ".opc");
  const agentsPath = nodePath.join(opcDir, "agents.json");
  const companiesPath = nodePath.join(opcDir, "companies.json");
  const warns: string[] = [];
  if (!nodeFs.existsSync(agentsPath)) {
    warns.push(".opc/agents.json 不存在(若非全新项目,极可能是 projectRoot 指错了)");
  } else {
    try {
      const agents = JSON.parse(nodeFs.readFileSync(agentsPath, "utf-8"));
      if (!Array.isArray(agents) || agents.length < 1) warns.push(`.opc/agents.json 里 agent 数异常(${Array.isArray(agents) ? agents.length : "非数组"})`);
    } catch { warns.push(".opc/agents.json 解析失败"); }
  }
  if (!nodeFs.existsSync(companiesPath)) warns.push(".opc/companies.json 不存在");
  if (warns.length) {
    console.warn(`\n[OPC] ⚠️ projectRoot=${abs} 校验警告:`);
    for (const w of warns) console.warn("[OPC]   - " + w);
    console.warn("[OPC]   若结果诡异,请确认是否该设 OPC_PROJECT_ROOT 指向真实项目根。\n");
  } else {
    console.log(`[OPC] projectRoot 校验通过: ${abs}`);
  }
}

export function startServer(port: number, projectRoot: string) {
  validateProjectRoot(projectRoot);
  // .opc 目录版本戳:磁盘版本高于本程序支持值 → 阻止启动,提示升级(而非静默按旧 schema 误读)。
  try {
    ensureStoreMeta(projectRoot);
  } catch (e) {
    console.error("\n========================================================================");
    console.error(`[OPC] 致命:${e instanceof Error ? e.message : String(e)}`);
    console.error("========================================================================\n");
    process.exit(1);
  }
  // SQLite is the default control plane. Existing JSON/JSONL remains untouched
  // and is migrated idempotently before any store is read. An independent
  // golden comparison prevents startup on a partial migration.
  if (isSqliteBackend(projectRoot)) {
    try {
      const migrated = migrateJsonToSqlite(projectRoot);
      const compared = goldenCompare(projectRoot);
      if (!compared.ok) {
        const bad = compared.sources.filter((source) =>
          source.mismatched.length || source.missing.length || source.extra.length);
        throw new Error(`SQLite migration verification failed for ${bad.map((source) => source.source).join(", ")}`);
      }
      if (migrated.totalRows > 0) {
        console.log(`[OPC] SQLite migration: ${migrated.totalRows} records verified`);
      }
    } catch (error) {
      console.error(`[OPC] SQLite startup migration failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
  const memoryIndex = rebuildLayeredMemorySearchIndex(projectRoot);
  if (memoryIndex.records > 0) {
    console.log(`[OPC] Layered memory index: ${memoryIndex.records} records across ${memoryIndex.scopes} scopes`);
  }
  if (memoryIndex.errors.length > 0) {
    console.warn("[OPC] Some layered memory indexes kept their previous version:", memoryIndex.errors);
  }
  setProjectRoot(projectRoot);
  setToolsProjectRoot(projectRoot);
  setModelGatewayRoot(projectRoot);
  setEventPersistRoot(projectRoot);
  setUsageRoot(projectRoot);
  // P0#8:启动对账。进程重启前若有 run 卡在 status==="running"(旧进程崩了/被杀),磁盘上会
  // 一直留着僵尸 run(不会再有任何人把它置为 done/failed)。启动时不可能还有活 run，统一改写。
  try {
    const { reconciled } = reconcileRunningTasksOnStartup(projectRoot);
    if (reconciled > 0) console.log(`[OPC] 启动对账:${reconciled} 个僵尸 running run 已标记为 failed`);
  } catch (e) {
    console.warn("[OPC] 启动对账失败(不影响启动):", e);
  }
  // 任务图同款对账:executeGraph 中途被杀会留下永远 running 的图(run 级对账管不到 task-graphs.json)。
  try {
    const { reconciled } = reconcileRunningTaskGraphsOnStartup(projectRoot);
    if (reconciled > 0) console.log(`[OPC] 启动对账:${reconciled} 个僵尸 running 任务图已标记为 failed`);
  } catch (e) {
    console.warn("[OPC] 任务图启动对账失败(不影响启动):", e);
  }
  // 审计 P2:历史 run 重分类(幂等一次性迁移)。输出为失败文本/内容乱码却 status 成功的旧 run 补 degraded 标注。
  try {
    const { reclassified, skippedMarker } = reclassifyLegacyRunsOnStartup(projectRoot);
    if (reclassified > 0) console.log(`[OPC] 历史 run 重分类:${reclassified} 个失败文本/乱码旧 run 已补 degraded 标注`);
    else if (!skippedMarker) console.log(`[OPC] 历史 run 重分类:无待迁移项`);
  } catch (e) {
    console.warn("[OPC] 历史 run 重分类失败(不影响启动):", e);
  }
  // 成本/额度:每次模型调用(model_call_finished,各引擎都发且带 provider)按 provider 累计到 usageStore。
  subscribeEvents((ev) => {
    if (ev.type !== "model_call_finished") return;
    const p = ev.payload as { provider?: string; promptTokens?: number; completionTokens?: number; simulated?: boolean } | undefined;
    if (!p?.provider) return;
    // MUP Gate A#2:mock 伪 tokens 分列,不进真实用量/订阅窗口(ledger 派生路径经 payload.simulated 天然分列)。
    recordUsage(p.provider, p.promptTokens ?? 0, p.completionTokens ?? 0, { simulated: p.simulated === true });
  });
  // B3 · Ledger 真实计费流水:旁挂订阅(不改上面的 recordUsage 累计)。每次模型调用落一条 append-only
  // 哈希链 model_call 行(costSource 据 usageEstimated 诚实判 estimated_len4 / api_reported / pricing_table);
  // run 收尾落 run_end 汇总行并对账(run_end totals 必须 == 该 run model_call 求和,不一致落 reconcile_mismatch)。
  // 全程 best-effort(ledgerStore 内 NEVER throws),绝不碰 orchestrator。
  subscribeEvents((ev) => {
    if (ev.type === "model_call_finished") {
      const p = (ev.payload ?? {}) as { provider?: string; model?: string; promptTokens?: number; completionTokens?: number; cost?: number; usageEstimated?: boolean; engine?: string; executor?: string };
      appendLedger(projectRoot, {
        kind: "model_call",
        runId: ev.runId, agentId: ev.agentId,
        provider: p.provider, model: p.model,
        promptTokens: p.promptTokens, completionTokens: p.completionTokens,
        costUsd: p.cost, costSource: deriveCostSource(p),
        engine: p.engine, executor: p.executor,
        payload: p,
      });
    } else if (ev.type === "run_finished") {
      const p = (ev.payload ?? {}) as { runId?: string; totalTokens?: number; totalCost?: number };
      appendRunEndWithReconcile(projectRoot, p.runId ?? ev.runId, p.totalTokens, p.totalCost);
    }
  });
  initA2ASdk(); // Phase 4:写出 A2A code-execution SDK 到临时目录,供 worker 子进程调用
  initEngineRouter();
  initOrchestrator(projectRoot);
  if (process.env.NODE_ENV !== "test") {
    try {
      const migration = migrateLegacyPersonaSkills(projectRoot, getAgents(), (agentId, systemPrompt) => {
        if (!updateAgent(agentId, { systemPrompt })) throw new Error(`agent ${agentId} not found`);
      });
      if (migration.removedSkillIds.length > 0) {
        console.log(`[OPC] migrated ${migration.migratedAgentIds.length} employee persona prompt(s); removed ${migration.removedSkillIds.length} legacy persona Skill record(s)`);
      }
      if (migration.failedSkillIds.length > 0) {
        console.warn(`[OPC] persona Skill migration failed for: ${migration.failedSkillIds.join(", ")}`);
      }
    } catch (error) {
      console.warn("[OPC] legacy persona Skill migration failed:", error);
    }
  }
  loadCommunityIndex(projectRoot);
  syncBuiltinContent(projectRoot);
  seedDefaultMcpServers(projectRoot);
  loadPricing(projectRoot);
  initProviderHealth(projectRoot);

  // Register provider handlers from config.apiKeys (presets) + providers.json (custom baseUrl).
  // Providers with no key are simply not registered → at runtime those nodes yield a restricted
  // result instead of faking success.
  const registered = syncProvidersFromStore(projectRoot);
  console.log(`Registered providers: ${registered.join(", ") || "(none — nodes will be restricted until keys are set)"}`);

  // 令五.6:确定本进程 session token(优先继承 env OPC_SESSION_TOKEN,便于 Electron/CLI 父进程与
  // worker 子进程共用同一 token),并写用户级只读文件供 CLI/Electron 兜底读取(绝不写仓库 .opc 提交区)。
  const sessionToken = getSessionToken();
  persistSessionTokenFile(port);
  console.log(`[OPC] API session token ready (…${sessionToken.slice(-6)});变更型请求需带 X-OPC-Session-Token`);

  const app = express();
  // Stage 9 安全:CORS 只放行 localhost 源 + 同源/Electron(无 origin)。挡掉恶意网页跨源 fetch 读响应
  // (如偷 /api/config)。注:CORS 只控浏览器读响应,不防 CSRF 触发副作用——后者留作残留(需 auth/CSRF token)。
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // 同源 / Electron file:// / curl
      try {
        const h = new URL(origin).hostname;
        if (h === "localhost" || h === "127.0.0.1" || h === "[::1]") return cb(null, true);
      } catch { /* 非法 origin → 拒 */ }
      cb(null, false);
    },
  }));
  app.use(express.json({ limit: "20mb" }));

  // 令五.6 / Gate D#15:本机 API session token 鉴权(CORS 后、路由注册前)。所有**变更型**请求
  // (POST/PATCH/PUT/DELETE)必须携带启动时生成的随机 token(X-OPC-Session-Token 头,或 SSE 用
  // query token 兜底),否则 401(缺)/403(不匹配)。GET/HEAD/OPTIONS 只读放行(REST 语义无副作用,
  // 既有 GET 端点零改动)。单靠 CORS 挡不住 CSRF(只挡跨源读响应),token 才能根断恶意网页驱动的副作用请求。
  app.use(sessionAuthMiddleware);

  // Bootstrap:同源前端(dev 下 vite 提供的 HTML 无 meta 时)取 token。GET 中间件放行;跨源恶意网页
  // 受 CORS 保护读不到响应体 → 拿不到 token。生产环境首页 HTML 已内联 <meta>,前端优先读 meta,此为兜底。
  app.get("/api/session/token", (_req, res) => res.json({ token: getSessionToken() }));

  // Serve the built web UI in production (packaged Electron); fall back to the vite dev server in
  // development. Lets the desktop app load the UI from the same origin as the API.
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const webDist = [
    process.env.OPC_WEB_DIST,
    nodePath.resolve(here, "../../web/dist"),
    nodePath.resolve(here, "../../../apps/web/dist"),
    nodePath.resolve(process.cwd(), "apps/web/dist"),
  ].filter(Boolean).find(p => nodeFs.existsSync(nodePath.join(p as string, "index.html"))) as string | undefined;

  if (webDist) {
    // index:false → 目录请求("/")不由 static 直出裸 index.html,而交给下面的处理器注入 session token
    // 的 <meta>(令五.6 首页下发路径:跨源网页读不到我们的 HTML → 拿不到 token)。其余静态资源照常。
    app.use(express.static(webDist, { index: false }));
    const indexHtmlPath = nodePath.join(webDist, "index.html");
    app.get("/", (_req, res) => {
      try {
        const html = nodeFs.readFileSync(indexHtmlPath, "utf-8");
        res.type("html").send(injectSessionTokenMeta(html));
      } catch {
        res.sendFile(indexHtmlPath);
      }
    });
    console.log(`Serving web UI from ${webDist}`);
  } else {
    app.get("/", (_req, res) => res.redirect("http://localhost:5173"));
  }

  registerConfigRoutes(app, projectRoot);
  registerFileRoutes(app, projectRoot);
  registerA2ARoutes(app, projectRoot);
  registerWebRoutes(app, projectRoot);
  registerAgentRoutes(app, projectRoot);
  registerRunRoutes(app, projectRoot);
  registerConflictRoutes(app, projectRoot); // 波6:合并冲突人类决裁 API(GET 列表/GET diff/POST resolve)
  registerCommunityRoutes(app, projectRoot);
  registerEventRoutes(app, projectRoot);
  registerPricingRoutes(app, projectRoot);
  registerProviderRoutes(app, projectRoot);
  registerSkillRoutes(app, projectRoot);
  registerMcpRoutes(app, projectRoot);
  registerChatRoutes(app, projectRoot);
  registerFrameworkRoutes(app, projectRoot);
  registerModelCatalogRoutes(app, projectRoot);
  registerAccountRoutes(app, projectRoot);
  registerMemoryRoutes(app, projectRoot);
  registerGoalRoutes(app, projectRoot);
  registerLoopRoutes(app, projectRoot);
  // harness 内核:agent 排队的自动化(schedule_goal/loop)在系统空闲时自动开跑
  registerAutomationStarters({ goal: (r, pr, o) => startGoal(r, pr, o), loop: (r, pr, o) => startLoop(r, pr, o), busy: () => isGoalInFlight() || isLoopInFlight() });
  startAutomationScheduler(projectRoot);
  registerCompanyRoutes(app, projectRoot);
  registerArchitectRoutes(app, projectRoot);
  registerCompanyArchitectRoutes(app, projectRoot);
  registerCostRoutes(app, projectRoot);
  registerGithubRoutes(app, projectRoot);
  registerSetupRoutes(app, projectRoot);
  registerMissionRoutes(app, projectRoot);
  registerTaskRoutes(app, projectRoot);
  registerCeoRoutes(app, projectRoot);
  registerDoctorRoutes(app, projectRoot);
  registerGovernanceRoutes(app, projectRoot);
  registerOnboardingRoutes(app, projectRoot);
  registerArchiveRoutes(app, projectRoot);

  const server = createServer(app);
  const stopMemoryCurator = scheduleMemoryCurator(projectRoot);
  server.on("close", stopMemoryCurator);
  // P0#8:listen 失败(最常见 EADDRINUSE)不能任由 Node 抛裸堆栈退出——打印可读原因后干净退出，
  // 便于桌面端/脚本判断"端口被占"而不是把它当成未知崩溃。
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[OPC] 致命:端口 ${port} 已被占用，服务器无法启动。请先结束占用该端口的进程，或换个端口。`);
    } else {
      console.error(`[OPC] 致命:服务器启动失败 - ${err.message}`);
    }
    process.exit(1);
  });
  // Stage 9 安全:绑 127.0.0.1(显式 IPv4 loopback)。既解决 Windows 默认绑 IPv6 `::` 导致 127.0.0.1
  // 客户端(Hermes curl / Python httpx)秒拒的问题,又**不暴露到 LAN**(0.0.0.0 会让同网设备直连高危端点)。
  server.listen(port, "127.0.0.1", () => {
    console.log(`OPC Studio server running on http://127.0.0.1:${port}`);
  });

  // P0#8:SIGINT/SIGTERM 优雅退出——打日志后关闭 HTTP server 再退出，避免裸崩/端口未释放。
  // 无已知子进程管理器可调用，不做过度设计。
  const shutdown = (signal: string) => {
    console.log(`[OPC] 收到 ${signal}，正在优雅退出...`);
    server.close(() => process.exit(0));
    // 若 close 迟迟不回调(有连接未断开),兜底强制退出。
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return server;
}

// CLI entry
if (isCliEntry()) {
  const PORT = parseInt(process.env.PORT || "3100", 10);
  const ROOT = resolveCliProjectRoot();
  startServer(PORT, ROOT);
}

