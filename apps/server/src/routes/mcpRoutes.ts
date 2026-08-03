import type { Express } from "express";
import { v4 as uuid } from "uuid";
import { McpServerConfigSchema } from "@opc/shared";
import type { McpServerConfig } from "@opc/shared";
import {
  listMcpServers, getMcpServer, addMcpServer, updateMcpServer, deleteMcpServer,
} from "../storage/mcpStore.js";
import { spawn } from "node:child_process";
import { safeFetch, normalizeStdioCommand, validateCommandArgs, validateProcessEnvPatch } from "../security/localGuards.js";
import { maskApiKey } from "./providerRoutes.js";
import { evaluateServer, loadPolicy } from "../runtime/mcpGovernance.js";
import {
  approveMcpServer, mcpApprovalDescriptor, revokeMcpApproval, validMcpApproval,
} from "../runtime/mcpApproval.js";
import { consumeConfirmationToken, issueConfirmationToken } from "../storage/companyEditProposalStore.js";

// MUP B7 · MCP env 不向 API 回传明文(仿 providerRoutes maskProvider 模式,只掩响应,不改存储/schema)。
// env 值多为 token/密钥,统一前4后2掩码;运行时消费(mcpGovernance/引擎 spawn)直接读 store,不受影响。
function maskMcpServer(s: McpServerConfig): McpServerConfig {
  if (!s.env || !Object.keys(s.env).length) return s;
  return { ...s, env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, maskApiKey(v)])) };
}

// 掩码往返不回写:PATCH 收到的 env 值若仍是 GET 回显的掩码串(用户没碰这个字段),用存量真值覆盖回去。
function restoreMaskedEnv(bodyEnv: unknown, existingEnv: Record<string, string> | undefined): unknown {
  if (!bodyEnv || typeof bodyEnv !== "object" || Array.isArray(bodyEnv) || !existingEnv) return bodyEnv;
  return Object.fromEntries(Object.entries(bodyEnv as Record<string, string>).map(([k, v]) => {
    const prev = existingEnv[k];
    return [k, prev !== undefined && v === maskApiKey(prev) ? prev : v];
  }));
}

function mcpApprovalSummary(projectRoot: string, server: McpServerConfig) {
  const descriptor = mcpApprovalDescriptor(projectRoot, server);
  return {
    serverId: server.id,
    name: server.name,
    transport: descriptor.transport,
    command: descriptor.command,
    args: descriptor.args,
    url: descriptor.url,
    envNames: descriptor.envNames,
    envValueHashes: descriptor.envValueHashes,
    workspaceHash: descriptor.workspaceHash,
    descriptorHash: descriptor.descriptorHash,
    bindingHash: descriptor.bindingHash,
  };
}

function requiresMcpApproval(projectRoot: string, server: McpServerConfig): boolean {
  return evaluateServer(server, loadPolicy(projectRoot)).permission === "needs-confirmation";
}

function issueMcpApprovalChallenge(projectRoot: string, server: McpServerConfig) {
  const summary = mcpApprovalSummary(projectRoot, server);
  const issued = issueConfirmationToken("mcp-server-approve", summary.bindingHash);
  return {
    error: "MCP server approval required",
    requiresConfirmation: true,
    confirmationToken: issued.token,
    tokenExpiresAt: issued.expiresAt,
    approval: summary,
  };
}

export function register(app: Express, projectRoot: string) {

  app.get("/api/mcp", (_req, res) => {
    res.json(listMcpServers(projectRoot).map(maskMcpServer));
  });

  app.get("/api/mcp/:id", (req, res) => {
    const s = getMcpServer(projectRoot, req.params.id);
    if (!s) { res.status(404).json({ error: "not found" }); return; }
    res.json(maskMcpServer(s));
  });

  app.post("/api/mcp", (req, res) => {
    const now = new Date().toISOString();
    const body = { ...req.body, id: req.body.id || uuid(), createdAt: req.body.createdAt || now };
    const parse = McpServerConfigSchema.safeParse(body);
    if (!parse.success) { res.status(400).json({ error: parse.error.issues }); return; }
    const server = addMcpServer(projectRoot, parse.data);
    res.status(201).json(maskMcpServer(server));
  });

  app.patch("/api/mcp/:id", (req, res) => {
    const existing = getMcpServer(projectRoot, req.params.id);
    if (!existing) { res.status(404).json({ error: "not found" }); return; }
    const body = { ...req.body };
    if (body.env !== undefined) body.env = restoreMaskedEnv(body.env, existing.env);
    const updated = updateMcpServer(projectRoot, req.params.id, body);
    res.json(updated ? maskMcpServer(updated) : updated);
  });

  app.delete("/api/mcp/:id", (req, res) => {
    const ok = deleteMcpServer(projectRoot, req.params.id);
    if (!ok) { res.status(404).json({ error: "not found" }); return; }
    revokeMcpApproval(projectRoot, req.params.id);
    res.json({ ok: true });
  });

  app.post("/api/mcp/:id/confirm", (req, res) => {
    const server = getMcpServer(projectRoot, req.params.id);
    if (!server) { res.status(404).json({ error: "not found" }); return; }
    const required = requiresMcpApproval(projectRoot, server);
    const existing = validMcpApproval(projectRoot, server);
    if (!required || existing) {
      res.json({ ok: true, required, approval: existing ? {
        ...mcpApprovalSummary(projectRoot, server), approvedAt: existing.approvedAt, expiresAt: existing.expiresAt,
      } : mcpApprovalSummary(projectRoot, server) });
      return;
    }
    const bindingHash = mcpApprovalDescriptor(projectRoot, server).bindingHash;
    const consumed = consumeConfirmationToken("mcp-server-approve", req.body?.confirmationToken, bindingHash);
    if (consumed !== "ok") {
      res.status(428).json({ ...issueMcpApprovalChallenge(projectRoot, server), confirmationStatus: consumed });
      return;
    }
    const approval = approveMcpServer(projectRoot, server);
    res.json({ ok: true, required: true, approval: {
      ...mcpApprovalSummary(projectRoot, server), approvedAt: approval.approvedAt, expiresAt: approval.expiresAt,
    } });
  });

  app.post("/api/mcp/:id/test", async (req, res) => {
    const server = getMcpServer(projectRoot, req.params.id);
    if (!server) { res.status(404).json({ error: "not found" }); return; }
    if (requiresMcpApproval(projectRoot, server) && !validMcpApproval(projectRoot, server)) {
      res.status(428).json(issueMcpApprovalChallenge(projectRoot, server));
      return;
    }

    try {
      if (server.transport === "stdio" && server.command) {
        const command = normalizeStdioCommand(server.command);
        const args = validateCommandArgs(server.args || [], command);
        const envPatch = validateProcessEnvPatch(server.env || {});
        const proc = spawn(command, args, {
          env: { ...process.env, ...envPatch },
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 10000,
          shell: false,
          windowsHide: true,
        });
        let stderr = "";
        const timeout = setTimeout(() => { proc.kill(); }, 8000);

        await new Promise<void>((resolve, reject) => {
          proc.on("error", (err) => {
            clearTimeout(timeout);
            stderr = err.message;
            reject(err);
          });
          proc.on("exit", (code) => {
            clearTimeout(timeout);
            if (code === 0 || code === null) resolve();
            else reject(new Error(`Process exited with code ${code}`));
          });
          proc.stderr?.on("data", (d) => { stderr += d.toString(); });
          // Kill after short wait - we just want to verify it starts
          setTimeout(() => {
            proc.kill();
            resolve();
          }, 2000);
        });

        if (stderr && !stderr.includes("error")) {
          res.json({ ok: true, message: "Process started successfully" });
        } else if (stderr) {
          res.json({ ok: false, message: stderr.slice(0, 500) });
        } else {
          res.json({ ok: true, message: "Process started successfully" });
        }
      } else if (server.transport === "http" && server.url) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const resp = await safeFetch(server.url, { signal: controller.signal, method: "GET" }, { allowLocalNetwork: server.allowLocalNetwork === true });
          clearTimeout(timer);
          if (resp.ok) {
            res.json({ ok: true, message: `HTTP ${resp.status}` });
          } else {
            res.json({ ok: false, message: `HTTP ${resp.status}` });
          }
        } catch (e: any) {
          clearTimeout(timer);
          res.json({ ok: false, message: e.message || "Connection failed" });
        }
      } else {
        res.json({ ok: false, message: "Missing command (for stdio) or url (for http)" });
      }
    } catch (e: any) {
      res.json({ ok: false, message: e.message || "Test failed" });
    }
  });
}
