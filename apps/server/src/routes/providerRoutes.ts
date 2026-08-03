import type { Express } from "express";
import { v4 as uuid } from "uuid";
import { loadProviders, getProvider, addProvider, updateProvider, deleteProvider } from "../storage/providerStore.js";
import { ProviderConfigSchema } from "@opc/shared";
import type { ProviderConfig } from "@opc/shared";
import { listModels } from "../runtime/modelRegistry.js";
import { syncProvidersFromStore, resolveProviderKey, providerNetworkOptions } from "../runtime/providerRegistry.js";
import { safeFetch } from "../security/localGuards.js";

// 安全:GET/写入回显都不回传明文 apiKey(本机其它进程/跨源 fetch 都能偷走)。前4后2掩码,
// 够用户核对是哪把 key,又不暴露全文。
export function maskApiKey(key: string | undefined | null): string {
  if (!key) return key ?? "";
  if (key.length <= 6) return "***";
  return `${key.slice(0, 4)}****${key.slice(-2)}`;
}

// MUP B7:headers(可含 Authorization Bearer token)/env 与 apiKey 同口径掩码,不只掩 apiKey。
function maskRecordValues(rec: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!rec || !Object.keys(rec).length) return rec;
  return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, maskApiKey(v)]));
}

function maskProvider(p: ProviderConfig): ProviderConfig {
  const masked: ProviderConfig = { ...p };
  if (p.apiKey) masked.apiKey = maskApiKey(p.apiKey);
  if (p.headers && Object.keys(p.headers).length) masked.headers = maskRecordValues(p.headers)!;
  if (p.env && Object.keys(p.env).length) masked.env = maskRecordValues(p.env)!;
  return masked;
}

// 掩码往返不回写(headers/env 版,同 apiKey 模式):PATCH 值仍是 GET 回显的掩码串 → 用存量真值覆盖。
function restoreMaskedRecord(bodyRec: unknown, existingRec: Record<string, string> | undefined): unknown {
  if (!bodyRec || typeof bodyRec !== "object" || Array.isArray(bodyRec) || !existingRec) return bodyRec;
  return Object.fromEntries(Object.entries(bodyRec as Record<string, string>).map(([k, v]) => {
    const prev = existingRec[k];
    return [k, prev !== undefined && v === maskApiKey(prev) ? prev : v];
  }));
}

export function register(app: Express, projectRoot: string) {
  app.get("/api/providers", (_req, res) => {
    res.json(loadProviders(projectRoot).map(maskProvider));
  });

  // Selectable models for a provider — live-synced (merged with builtin) + cached, else builtin.
  app.get("/api/providers/:id/models", async (req, res) => {
    try { res.json(await listModels(projectRoot, req.params.id)); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/providers/:id", (req, res) => {
    const p = getProvider(projectRoot, req.params.id);
    if (!p) { res.status(404).json({ error: "not found" }); return; }
    res.json(maskProvider(p));
  });

  app.post("/api/providers", (req, res) => {
    const parse = ProviderConfigSchema.safeParse(req.body);
    if (!parse.success) { res.status(400).json({ error: parse.error.issues }); return; }
    if (getProvider(projectRoot, parse.data.id)) { res.status(409).json({ error: "provider id already exists" }); return; }
    const provider = addProvider(projectRoot, parse.data);
    try { syncProvidersFromStore(projectRoot); } catch { /* non-fatal */ }
    res.status(201).json(maskProvider(provider));
  });

  app.patch("/api/providers/:id", (req, res) => {
    const existing = getProvider(projectRoot, req.params.id);
    if (!existing) { res.status(404).json({ error: "not found" }); return; }
    const body = { ...req.body };
    // 掩码往返不回写:前端编辑表单里 apiKey 若仍是 GET 回显的掩码串(用户没碰这个字段),
    // 用原 key 覆盖回去,不然真 key 会被掩码串("sk-a****yz")冲掉。
    if (body.apiKey && body.apiKey === maskApiKey(existing.apiKey)) body.apiKey = existing.apiKey;
    if (body.headers !== undefined) body.headers = restoreMaskedRecord(body.headers, existing.headers);
    if (body.env !== undefined) body.env = restoreMaskedRecord(body.env, existing.env);
    const merged = { ...existing, ...body, id: existing.id, updatedAt: new Date().toISOString() } as ProviderConfig;
    const parse = ProviderConfigSchema.safeParse(merged);
    if (!parse.success) { res.status(400).json({ error: parse.error.issues }); return; }
    const updated = updateProvider(projectRoot, req.params.id, parse.data);
    try { syncProvidersFromStore(projectRoot); } catch { /* non-fatal */ }
    res.json(updated ? maskProvider(updated) : updated);
  });

  app.delete("/api/providers/:id", (req, res) => {
    const ok = deleteProvider(projectRoot, req.params.id);
    if (!ok) { res.status(404).json({ error: "not found" }); return; }
    res.json({ ok: true });
  });

  app.post("/api/providers/test", async (req, res) => {
    const { apiFormat, baseUrl, model, prompt, timeoutMs, providerId } = req.body;
    let { apiKey } = req.body;
    // 真实 bug(用户反馈):表单里的 apiKey 要么是 GET 回显的掩码串("sk-a****yz"),要么对"密钥
    // 走 env 变量/.opc/keys/{provider}.key 而非直接填在 config 里"的供应商压根是空的——这两种情况直接
    // 拿 form.apiKey 去测,测的不是这个供应商真正在用的 key,必然测试失败、报"没有 API key"/鉴权错误,
    // 即便这个供应商在真实任务执行时(走 collectApiKeys 全链路解析)完全能用。这里补上:是掩码串或为空、
    // 且带了 providerId,就换成通过完整解析链(env > keys 文件 > config)拿到的真实 key 再测。
    const existing = providerId ? getProvider(projectRoot, providerId) : undefined;
    const looksMasked = existing && apiKey === maskApiKey(existing.apiKey);
    if (looksMasked && existing?.apiKey) apiKey = existing.apiKey;
    if (!apiKey && providerId) apiKey = resolveProviderKey(projectRoot, providerId) || apiKey;
    const t0 = Date.now();
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      let body: string;
      let url: string;
      const testPrompt = prompt || "Say hello in one word.";
      const testModel = model || "default";

      switch (apiFormat) {
        case "openai":
          url = `${baseUrl}/chat/completions`;
          headers["Authorization"] = `Bearer ${apiKey}`;
          body = JSON.stringify({ model: testModel, messages: [{ role: "user", content: testPrompt }], max_tokens: 10 });
          break;
        case "anthropic":
          url = `${baseUrl}/messages`;
          headers["x-api-key"] = apiKey;
          headers["anthropic-version"] = "2023-06-01";
          body = JSON.stringify({ model: testModel, messages: [{ role: "user", content: testPrompt }], max_tokens: 10 });
          break;
        case "gemini":
          url = `${baseUrl}/models/${testModel}:generateContent?key=${apiKey}`;
          body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: testPrompt }] }] });
          break;
        case "ollama":
          url = `${baseUrl}/chat`;
          body = JSON.stringify({ model: testModel, messages: [{ role: "user", content: testPrompt }], stream: false });
          break;
        default:
          url = `${baseUrl}/chat/completions`;
          headers["Authorization"] = `Bearer ${apiKey}`;
          body = JSON.stringify({ model: testModel, messages: [{ role: "user", content: testPrompt }], max_tokens: 10 });
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs || 15000);

      const allowLocalNetwork = req.body?.allowLocalNetwork === true || existing?.allowLocalNetwork === true || existing?.kind === "local" || apiFormat === "ollama";
      const resp = await safeFetch(
        url,
        { method: "POST", headers, body, signal: controller.signal },
        providerNetworkOptions(providerId ?? existing?.id ?? "", baseUrl, allowLocalNetwork, existing?.kind),
      );
      clearTimeout(timer);

      const latencyMs = Date.now() - t0;
      let message = "";
      try {
        const data = await resp.json();
        if (apiFormat === "anthropic") message = data?.content?.[0]?.text || JSON.stringify(data);
        else if (apiFormat === "gemini") message = data?.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(data);
        else if (apiFormat === "ollama") message = data?.message?.content || JSON.stringify(data);
        else message = data?.choices?.[0]?.message?.content || JSON.stringify(data);
      } catch {
        message = resp.ok ? "OK" : `Error ${resp.status}`;
      }

      res.json({ ok: resp.ok, latencyMs, model: testModel, message });
    } catch (err: any) {
      const latencyMs = Date.now() - t0;
      res.json({ ok: false, latencyMs, model: model || "default", message: err.message || String(err) });
    }
  });
}
