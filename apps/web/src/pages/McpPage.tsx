import { useState, useEffect } from "react";
import { Plus, ExternalLink } from "lucide-react";
import { useMcpStore } from "../store/useMcpStore.js";
import { useAgentStore } from "../store/useAgentStore.js";
import type { McpServerConfig } from "@opc/shared";
import { confirmDialog } from "../components/common/ConfirmDialog.js";
import { useT } from "../i18n.js";
import type { ApiError } from "../api/client.js";

// Curated MCP presets. Each cites its real upstream (GitHub) so users know exactly what they enable
// — same "source-attributed, one-click" spirit as the codex / claude-code desktop MCP importers.
const MCP_PRESETS: {
  id: string; name: string; descKey: string; transport: "stdio";
  command: string; args: string[]; env?: Record<string, string>; source: string;
}[] = [
  {
    id: "github-mcp", name: "GitHub", descKey: "mcp.preset.github.desc",
    transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
    source: "https://github.com/github/github-mcp-server",
  },
  {
    id: "filesystem-mcp", name: "Filesystem", descKey: "mcp.preset.filesystem.desc",
    transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    id: "fetch-mcp", name: "Fetch", descKey: "mcp.preset.fetch.desc",
    transport: "stdio", command: "uvx", args: ["mcp-server-fetch"],
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },
  {
    id: "git-mcp", name: "Git", descKey: "mcp.preset.git.desc",
    transport: "stdio", command: "uvx", args: ["mcp-server-git", "--repository", "."],
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
  },
  {
    id: "memory-mcp", name: "Memory", descKey: "mcp.preset.memory.desc",
    transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"],
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
  },
  {
    id: "sequential-thinking-mcp", name: "Sequential Thinking", descKey: "mcp.preset.sequentialThinking.desc",
    transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
  },
  {
    id: "sqlite-mcp", name: "SQLite", descKey: "mcp.preset.sqlite.desc",
    transport: "stdio", command: "uvx", args: ["mcp-server-sqlite", "--db-path", "./data.db"],
    source: "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/sqlite",
  },
  {
    id: "playwright-mcp", name: "Playwright", descKey: "mcp.preset.playwright.desc",
    transport: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"],
    source: "https://github.com/microsoft/playwright-mcp",
  },
  {
    id: "brave-search-mcp", name: "Brave Search", descKey: "mcp.preset.braveSearch.desc",
    transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"],
    env: { BRAVE_API_KEY: "" },
    source: "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/brave-search",
  },
  {
    id: "slack-mcp", name: "Slack", descKey: "mcp.preset.slack.desc",
    transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"],
    env: { SLACK_BOT_TOKEN: "", SLACK_TEAM_ID: "" },
    source: "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/slack",
  },
];

export default function McpPage() {
  const t = useT();
  const store = useMcpStore();
  const agentStore = useAgentStore();
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string; testing: boolean }>>({});
  const [form, setForm] = useState<Partial<McpServerConfig>>({
    transport: "stdio",
    enabled: true,
    assignedAgents: [],
  });

  useEffect(() => { store.load(); agentStore.load(); }, []);

  const resetForm = () => {
    setForm({ transport: "stdio", enabled: true, assignedAgents: [] });
    setEditId(null);
  };

  const ensureMcpApproval = async (id: string): Promise<boolean> => {
    try {
      await store.approve(id);
      return true;
    } catch (error) {
      const apiError = error as ApiError;
      const body = apiError.body as {
        confirmationToken?: unknown;
        tokenExpiresAt?: unknown;
        approval?: {
          name?: unknown; transport?: unknown; command?: unknown; args?: unknown; url?: unknown;
          envNames?: unknown; workspaceHash?: unknown;
        };
      } | undefined;
      if (apiError.status !== 428 || typeof body?.confirmationToken !== "string") throw error;
      const approval = body.approval;
      const args = Array.isArray(approval?.args) ? approval.args.filter((v): v is string => typeof v === "string") : [];
      const command = typeof approval?.command === "string" ? [approval.command, ...args].join(" ")
        : typeof approval?.url === "string" ? approval.url : String(approval?.transport ?? "MCP");
      const envNames = Array.isArray(approval?.envNames)
        ? approval.envNames.filter((v): v is string => typeof v === "string").join(", ")
        : "";
      const workspaceHash = typeof approval?.workspaceHash === "string" ? approval.workspaceHash.slice(0, 20) : "";
      const confirmed = await confirmDialog({
        title: `${t("common.confirm")} MCP: ${String(approval?.name ?? id)}`,
        body: [command, envNames ? `Env: ${envNames}` : "Env: none", workspaceHash ? `Workspace: ${workspaceHash}...` : ""]
          .filter(Boolean).join(" · "),
        danger: true,
        confirmLabel: t("common.confirm"),
        cancelLabel: t("common.cancel"),
      });
      if (!confirmed) return false;
      await store.approve(id, body.confirmationToken);
      return true;
    }
  };

  const handleAddPreset = (preset: typeof MCP_PRESETS[number]) => {
    setForm({
      ...preset,
      id: undefined,
      description: t(preset.descKey),
      enabled: true,
      assignedAgents: [],
      env: preset.env || {},
    });
    setShowAdd(true);
  };

  const handleSave = async () => {
    const now = new Date().toISOString();
    const server: McpServerConfig = {
      id: editId || crypto.randomUUID(),
      name: form.name || "Unnamed",
      description: form.description || "",
      transport: form.transport || "stdio",
      command: form.transport === "stdio" ? form.command : undefined,
      args: form.transport === "stdio" ? form.args : undefined,
      url: form.transport === "http" ? form.url : undefined,
      allowLocalNetwork: form.transport === "http" ? form.allowLocalNetwork === true : undefined,
      env: form.env,
      enabled: form.enabled ?? true,
      assignedAgents: form.assignedAgents || [],
      createdAt: form.createdAt || now,
    };
    const requestedEnabled = server.enabled;
    try {
      if (editId) {
        await store.update(editId, { ...server, enabled: false });
      } else {
        await store.create({ ...server, enabled: false });
      }
      if (requestedEnabled && await ensureMcpApproval(server.id)) {
        await store.update(server.id, { enabled: true });
      }
      setShowAdd(false);
      resetForm();
    } catch (e) {
      console.error("Failed to save MCP server:", e);
    }
  };

  const handleTest = async (id: string) => {
    setTestResults(prev => ({ ...prev, [id]: { ok: false, message: t('mcp.testing'), testing: true } }));
    try {
      if (!await ensureMcpApproval(id)) {
        setTestResults(prev => ({ ...prev, [id]: { ok: false, message: t('common.cancel'), testing: false } }));
        return;
      }
      const result = await store.test(id);
      setTestResults(prev => ({ ...prev, [id]: { ...result, testing: false } }));
    } catch (e: any) {
      setTestResults(prev => ({ ...prev, [id]: { ok: false, message: e.message || t('mcp.testFailed'), testing: false } }));
    }
  };

  const handleToggle = async (server: McpServerConfig) => {
    if (!server.enabled && !await ensureMcpApproval(server.id)) return;
    await store.update(server.id, { enabled: !server.enabled });
  };

  const handleDelete = async (id: string) => {
    if (!await confirmDialog({ title: t('mcp.confirmDeleteTitle'), danger: true, confirmLabel: t('common.delete'), cancelLabel: t('common.cancel') })) return;
    await store.remove(id);
  };

  const startEdit = (server: McpServerConfig) => {
    setEditId(server.id);
    setForm({ ...server });
    setShowAdd(true);
  };

  const agentOptions = agentStore.agents.filter(a => a.editable !== false);

  return (
    <div className="h-full flex flex-col bg-bg-primary">
      <div className="px-6 py-4 bg-bg-card border-b border-border flex items-center justify-between">
        <h2 className="m-0 text-lg font-semibold text-text-primary">{t('mcp.title')}</h2>
        <button onClick={() => { resetForm(); setShowAdd(true); }} className="btn-primary flex items-center gap-1">
          <Plus size={14} /> {t('mcp.addServer')}
        </button>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {/* Recommended Presets */}
        <div className="mb-5">
          <h3 className="text-sm font-semibold text-text-primary m-0 mb-2.5">{t('mcp.recommendedPresets')}</h3>
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {MCP_PRESETS.map(preset => (
              <div key={preset.id}
                className="bg-bg-card rounded-xl border border-border p-4 cursor-pointer shadow-sm hover:shadow-md hover:border-accent/40 transition-all"
                onClick={() => handleAddPreset(preset)}>
                <div className="font-semibold text-sm text-text-primary mb-1">{preset.name}</div>
                <div className="text-xs text-text-secondary mb-2">{t(preset.descKey)}</div>
                <code className="block break-all text-[11px] bg-bg-hover px-1.5 py-0.5 rounded text-text-secondary">
                  {preset.command} {preset.args?.join(" ")}
                </code>
                {preset.env && Object.keys(preset.env).length > 0 && (
                  <div className="text-[11px] text-amber mt-1.5">
                    {t('mcp.needsConfig')}: {Object.keys(preset.env).join(", ")}
                  </div>
                )}
                <a href={preset.source} target="_blank" rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  className="inline-flex items-center gap-1 text-[11px] text-accent mt-2 hover:underline">
                  <ExternalLink size={11} /> {t('mcp.source')}
                </a>
              </div>
            ))}
          </div>
        </div>

        {/* Server Cards */}
        <h3 className="text-sm font-semibold text-text-primary m-0 mb-2.5">{t('mcp.addedServers')}</h3>
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
          {store.servers.map(server => {
            const tr = testResults[server.id];
            return (
              <div key={server.id} className="bg-bg-card rounded-xl border border-border p-4 shadow-sm">
                <div className="flex justify-between items-start mb-1.5">
                  <div>
                    <div className="font-semibold text-sm text-text-primary">{server.name}</div>
                    <div className="text-xs text-text-secondary mt-0.5">{server.description}</div>
                  </div>
                  <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] ${
                    server.enabled ? "bg-green/10 text-green" : "bg-red/10 text-red"
                  }`}>
                    {server.enabled ? t('mcp.enabled') : t('mcp.disabled')}
                  </span>
                </div>

                <div className="text-[11px] text-text-muted mb-2">
                  {t('mcp.transport')}: {server.transport.toUpperCase()}
                  {server.transport === "stdio" && server.command && (
                    <code className="ml-2 bg-bg-hover px-1 py-0.5 rounded text-[10px]">
                      {server.command} {server.args?.join(" ") || ""}
                    </code>
                  )}
                  {server.transport === "http" && server.url && (
                    <code className="ml-2 bg-bg-hover px-1 py-0.5 rounded text-[10px]">{server.url}</code>
                  )}
                </div>

                {server.assignedAgents.length > 0 && (
                  <div className="flex gap-1 flex-wrap mb-2">
                    {server.assignedAgents.map(aId => {
                      const agent = agentOptions.find(a => a.id === aId);
                      return (
                        <span key={aId} className="px-1.5 py-0.5 rounded-full text-[10px] bg-purple/10 text-purple">
                          {agent?.name || aId}
                        </span>
                      );
                    })}
                  </div>
                )}

                <div className="flex gap-1.5 mt-2">
                  <button onClick={() => void handleToggle(server)}
                    className="px-2 py-0.5 border border-border rounded-full bg-bg-card cursor-pointer text-[11px] text-text-secondary hover:bg-bg-hover">
                    {server.enabled ? t('mcp.disabled') : t('mcp.enabled')}
                  </button>
                  <button onClick={() => handleTest(server.id)}
                    className={`px-2 py-0.5 border border-border rounded-full cursor-pointer text-[11px] hover:bg-bg-hover ${
                      tr?.ok ? "bg-green/10 text-green" : tr?.testing ? "bg-amber/10 text-amber" : "bg-bg-card text-text-secondary"
                    }`}>
                    {tr?.testing ? t('mcp.testing') : t('mcp.testConnection')}
                  </button>
                  <button onClick={() => startEdit(server)}
                    className="px-2 py-0.5 border border-border rounded-full bg-bg-card cursor-pointer text-[11px] text-text-secondary hover:bg-bg-hover">
                    {t('mcp.edit')}
                  </button>
                  <button onClick={() => handleDelete(server.id)}
                    className="px-2 py-0.5 border border-border rounded-full bg-bg-card cursor-pointer text-[11px] text-red hover:bg-red/10">
                    {t('common.delete')}
                  </button>
                </div>

                {tr && !tr.testing && (
                  <div className={`mt-2 px-2.5 py-1.5 rounded-md text-xs ${
                    tr.ok ? "bg-green/10 text-green" : "bg-red/10 text-red"
                  }`}>
                    {tr.ok ? t('mcp.connectSuccess') : t('mcp.connectFailed')}: {tr.message}
                  </div>
                )}
              </div>
            );
          })}
          {store.servers.length === 0 && (
            <div className="text-text-muted text-[13px] py-5">{t('mcp.emptyHint')}</div>
          )}
        </div>
      </div>

      {/* Add/Edit Modal */}
      {showAdd && (
        <div className="modal-overlay z-[100]" onClick={() => { setShowAdd(false); resetForm(); }}>
          <div className="bg-bg-card rounded-xl p-6 w-[560px] max-h-[80vh] overflow-auto shadow-lg" onClick={e => e.stopPropagation()}>
            <h3 className="m-0 mb-4 text-base font-semibold">{editId ? t('mcp.editServer') : t('mcp.addServerTitle')}</h3>

            <div className="flex flex-col gap-3">
              <div>
                <label className="block text-xs font-semibold text-text-primary mb-1">{t('mcp.name')}</label>
                <input value={form.name || ""} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  className="w-full border border-border rounded-md px-2.5 py-1.5 text-[13px] box-border outline-none focus:border-accent" placeholder="My MCP Server" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-text-primary mb-1">{t('mcp.description')}</label>
                <input value={form.description || ""} onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                  className="w-full border border-border rounded-md px-2.5 py-1.5 text-[13px] box-border outline-none focus:border-accent" placeholder={t('mcp.descPlaceholder')} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-text-primary mb-1">{t('mcp.transport')}</label>
                <select value={form.transport || "stdio"} onChange={e => setForm(p => ({ ...p, transport: e.target.value as "stdio" | "http" }))}
                  className="w-full border border-border rounded-md px-2.5 py-1.5 text-[13px] box-border bg-bg-card outline-none focus:border-accent">
                  <option value="stdio">{t('mcp.stdioLabel')}</option>
                  <option value="http">{t('mcp.httpLabel')}</option>
                </select>
              </div>

              {form.transport === "stdio" ? (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-text-primary mb-1">{t('mcp.command')}</label>
                    <input value={form.command || ""} onChange={e => setForm(p => ({ ...p, command: e.target.value }))}
                      className="w-full border border-border rounded-md px-2.5 py-1.5 text-[13px] box-border outline-none focus:border-accent" placeholder="npx" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-text-primary mb-1">{t('mcp.argsLabel')}</label>
                    <input value={JSON.stringify(form.args || [])} onChange={e => { try { setForm(p => ({ ...p, args: JSON.parse(e.target.value) })); } catch { /* ignore */ } }}
                      className="w-full border border-border rounded-md px-2.5 py-1.5 text-[13px] box-border outline-none focus:border-accent" placeholder='["-y", "@scope/server"]' />
                  </div>
                </>              ) : (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-text-primary mb-1">URL</label>
                    <input value={form.url || ""} onChange={e => setForm(p => ({ ...p, url: e.target.value }))}
                      className="w-full border border-border rounded-md px-2.5 py-1.5 text-[13px] box-border outline-none focus:border-accent" placeholder="https://example.com/mcp" />
                  </div>
                  <label className="inline-flex items-center gap-2 text-xs text-text-secondary">
                    <input type="checkbox" checked={form.allowLocalNetwork === true} onChange={e => setForm(p => ({ ...p, allowLocalNetwork: e.target.checked }))} />
                    Allow local network
                  </label>
                </>
              )}

              <div>
                <label className="block text-xs font-semibold text-text-primary mb-1">{t('mcp.envLabel')}</label>
                <input value={JSON.stringify(form.env || {})} onChange={e => { try { setForm(p => ({ ...p, env: JSON.parse(e.target.value) })); } catch { /* ignore */ } }}
                  className="w-full border border-border rounded-md px-2.5 py-1.5 text-[13px] box-border outline-none focus:border-accent" placeholder='{"KEY": "value"}' />
              </div>

              <div>
                <label className="block text-xs font-semibold text-text-primary mb-1">{t('mcp.assignAgent')}</label>
                <div className="flex gap-1.5 flex-wrap mt-1">
                  {agentOptions.map(a => {
                    const assigned = (form.assignedAgents || []).includes(a.id);
                    return (
                      <button key={a.id}
                        onClick={() => {
                          const current = form.assignedAgents || [];
                          setForm(p => ({
                            ...p,
                            assignedAgents: assigned ? current.filter(x => x !== a.id) : [...current, a.id],
                          }));
                        }}
                        className={`px-2.5 py-0.5 border border-border-light rounded-full text-xs cursor-pointer transition-colors ${
                          assigned ? "bg-accent/10 text-accent border-accent" : "bg-bg-card text-text-primary hover:bg-bg-hover"
                        }`}>
                        {a.name}
                      </button>
                    );
                  })}
                  {agentOptions.length === 0 && <span className="text-xs text-text-muted">{t('mcp.noAgents')}</span>}
                </div>
              </div>
            </div>

            <div className="flex gap-2 mt-5 justify-end">
              <button onClick={() => { setShowAdd(false); resetForm(); }} className="btn-secondary">{t('common.cancel')}</button>
              <button onClick={handleSave} className="btn-primary">{editId ? t('common.save') : t('mcp.add')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
