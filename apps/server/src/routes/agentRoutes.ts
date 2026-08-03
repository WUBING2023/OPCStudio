import type { Express } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgents, updateAgent } from "../runtime/orchestrator.js";
import { resolveDefaultFramework } from "../runtime/defaultFramework.js";
import { loadConfig, loadRunTask, updateReportMetaName } from "../storage/projectStore.js";
import { providerNetworkOptions, resolveProviderKey } from "../runtime/providerRegistry.js";
import { agentToCard } from "../runtime/companyTemplate.js";
import { redactShareContent } from "../runtime/templateDoctor.js";
import { checkTextIntegrity, CORRUPTED_INPUT_ERROR } from "../security/inputIntegrity.js";
import { safeFetch } from "../security/localGuards.js";
import { NativeExecutionPreferenceSchema, validateAgentWorkingDirectory } from "@opc/shared";

const PROVIDER_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/v1",
  minimax: "https://api.minimaxi.com/v1",
  doubao: "https://ark.cn-beijing.volces.com/api/v3",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

export function register(app: Express, projectRoot: string) {
  app.get("/api/agents", (_req, res) => {
    res.json(getAgents());
  });

  // 把一个活员工序列化成可分享的 AgentCard(worker 上传用)。
  // C2 · 员工卡此前完全裸奔无脱敏关口:card.summary/systemPrompt 可能夹带密钥/本机绝对路径。导出是
  // 外发方向,按公司 bundle 导出的先例(sanitizeBundleForExport)**脱敏放行**而非拦截——密钥/路径
  // 占位化([REDACTED_SECRET]/[REDACTED_PATH],与 runShareSafetyGate 扫的是同一组形态);后续走
  // /api/community/share 上传时安全闸照常把关(脱敏后的占位符不会再命中)。
  app.get("/api/agents/:id/export-card", (req, res) => {
    try { res.json(redactShareContent(agentToCard(projectRoot, req.params.id)).value); }
    catch (e: any) { res.status(404).json({ error: e.message }); }
  });

  app.patch("/api/agents/:id", async (req, res) => {
    if (req.body?.nativeExecution !== undefined) {
      const parsed = NativeExecutionPreferenceSchema.safeParse(req.body.nativeExecution);
      if (!parsed.success) {
        return res.status(400).json({
          error: "invalid native execution preference",
          code: "invalid_native_execution",
          details: parsed.error.flatten(),
        });
      }
      req.body.nativeExecution = parsed.data;
    }
    // agent.name 会直接进最终报告的页脚 contributions(orchestrator.ts generateMarkdownReport),
    // 一旦这里放行乱码,后续每次报告都会带着这个坏名字——校验放在写入前,不是等报告生成后再补救。
    if (typeof req.body?.name === "string") {
      const integrity = checkTextIntegrity(req.body.name);
      if (integrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: integrity.reason });
    }
    // 收口令五.3(保存侧)· 员工级 workingDirectory 写侧强校验(与 runtime parallelExecutor 同一口径
    // validateAgentWorkingDirectory:必须相对路径、无 .. 逃逸、非空且非等价根)。非法→400,不再静默落盘
    // 供 run 起跑时才发现;空串="清空回 worktree 根"是合法操作,放行不校验;合法值规范化后落盘。
    if (typeof req.body?.workingDirectory === "string") {
      const raw = req.body.workingDirectory.trim();
      if (raw === "") {
        req.body.workingDirectory = "";
      } else {
        const check = validateAgentWorkingDirectory(raw);
        if (!check.ok) {
          return res.status(400).json({ error: check.error, code: "invalid_working_directory", detail: check.code });
        }
        req.body.workingDirectory = check.normalized;
      }
    }
    // 去 Hermes 默认值:新建员工(该 id 尚不存在且带 name+role 的 upsert)若未显式指定 framework,
    // 按"已装订阅优先,否则 API"解析,而不是让 orchestrator 无脑落成 hermes。仅对新建注入,避免覆盖
    // 既有员工(既有员工的 PATCH 不带 framework 时保持原值不变)。
    if (req.body && !req.body.framework && req.body.name && req.body.role
        && !getAgents().some(a => a.id === req.params.id)) {
      req.body.framework = await resolveDefaultFramework();
    }
    const updated = updateAgent(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "not found" });

    if (req.body.name) {
      updateReportMetaName(projectRoot, req.params.id, req.body.name);
    }

    res.json(updated);
  });

  app.post("/api/agents/:id/test", async (req, res) => {
    const agent = getAgents().find(a => a.id === req.params.id);
    if (!agent) return res.status(404).json({ error: "agent not found" });

    // 密钥经 env > keys/<provider>.key > config 链解析(Block C:明文 key 移出 config 后仍可用)。
    const apiKey = resolveProviderKey(projectRoot, agent.provider);
    if (!apiKey) {
      return res.status(400).json({ error: `No API key configured for provider "${agent.provider}"` });
    }

    const baseUrl = PROVIDER_URLS[agent.provider];
    if (!baseUrl) {
      // For providers not in the map, try to construct from known patterns
      if (agent.provider === "anthropic") {
        return res.json({ ok: true, message: "Anthropic provider registered (test via real run)", provider: agent.provider });
      }
      return res.status(400).json({ error: `Unknown provider base URL for "${agent.provider}"` });
    }

    try {
      const t0 = Date.now();
      const resp = await safeFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: agent.model,
          messages: [
            { role: "user", content: "Hello, respond with just 'OK'." },
          ],
          max_tokens: 10,
        }),
      }, providerNetworkOptions(agent.provider, baseUrl));

      const latencyMs = Date.now() - t0;

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        return res.json({
          ok: false,
          status: resp.status,
          error: errText.slice(0, 300),
          latencyMs,
          provider: agent.provider,
          model: agent.model,
        });
      }

      const data = await resp.json() as any;
      const content = data.choices?.[0]?.message?.content ?? "";
      const tokens = data.usage?.total_tokens ?? 0;

      res.json({
        ok: true,
        response: content.slice(0, 100),
        tokens,
        latencyMs,
        provider: agent.provider,
        model: agent.model,
      });
    } catch (e: any) {
      res.json({
        ok: false,
        error: e.message || String(e),
        provider: agent.provider,
        model: agent.model,
      });
    }
  });

  app.get("/api/agents/:id/runs", (req, res) => {
    try {
      const runsDir = path.join(projectRoot, ".opc", "runs");
      if (!fs.existsSync(runsDir)) return res.json([]);
      const requested = Number.parseInt(String(req.query.limit ?? "30"), 10);
      const limit = Number.isFinite(requested) ? Math.min(100, Math.max(1, requested)) : 30;

      const agentRuns: any[] = [];
      for (const dir of fs.readdirSync(runsDir)) {
        try {
          const task = loadRunTask(projectRoot, dir);
          if (!task) continue;
          if (task.participatingAgents?.includes(req.params.id)) {
            agentRuns.push({
              id: task.id,
              goal: task.userGoal || "",
              status: task.status || "unknown",
              startedAt: task.startedAt || "",
              endedAt: task.endedAt,
              totalTokens: task.totalTokens ?? 0,
              totalCostUsd: task.totalCostUsd ?? null,
              companyId: task.companyId,
            });
          }
        } catch { /* skip */ }
      }

      agentRuns.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      res.json(agentRuns.slice(0, limit));
    } catch {
      res.json([]);
    }
  });
}
