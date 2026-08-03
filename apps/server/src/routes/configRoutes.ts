import type { Express } from "express";
import { ProjectConfigPatchSchema } from "@opc/shared";
import { loadConfig, saveConfig } from "../storage/projectStore.js";
import { syncProvidersFromStore, collectApiKeys } from "../runtime/providerRegistry.js";
import { maskConfigSecrets } from "../security/redact.js";

export function register(app: Express, projectRoot: string) {
  app.get("/api/config", (_req, res) => {
    // Stage 9 安全:绝不向 API 回传明文 apiKeys/secret(任意网页跨源 fetch 会偷走)。只回掩码。
    const cfg = loadConfig(projectRoot);
    const masked = maskConfigSecrets(cfg) as any;
    // Block C:把经 env > keys/<provider>.key > config 链解析后"已配置"的 provider 也以掩码("***")回报,
    // 让 API 页能反映用 keys 目录 / 环境变量配置的 provider(否则明文移出 config 后,前端会误以为没配)。
    try {
      const resolved = collectApiKeys(projectRoot, cfg.apiKeys ?? {});
      masked.apiKeys = { ...(masked.apiKeys ?? {}) };
      for (const [p, v] of Object.entries(resolved)) if (v) masked.apiKeys[p] = "***";
    } catch { /* best-effort */ }
    res.json(masked);
  });

  app.post("/api/config", (req, res) => {
    // Validate the incoming patch, then validate the merged result — no dirty data reaches disk.
    const patch = ProjectConfigPatchSchema.safeParse(req.body);
    if (!patch.success) {
      return res.status(400).json({ error: patch.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") });
    }
    const existing = loadConfig(projectRoot);
    const c: any = { ...existing, ...patch.data };
    // Stage 9 安全:前端 POST 回掩码 "***" 时不覆盖真 key(掩码往返不抹掉密钥)。
    if (c.apiKeys && (existing as any).apiKeys) {
      c.apiKeys = { ...c.apiKeys };
      for (const [k, v] of Object.entries(c.apiKeys)) {
        if (v === "***") c.apiKeys[k] = (existing as any).apiKeys[k];
      }
    }
    saveConfig(projectRoot, c);
    // Hot-register newly-keyed providers so they work this run without a server restart.
    try { syncProvidersFromStore(projectRoot); } catch { /* non-fatal */ }
    res.json(maskConfigSecrets(c)); // 响应也掩码,不回明文
  });
}
