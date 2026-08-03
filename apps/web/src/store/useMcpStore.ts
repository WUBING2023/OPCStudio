import { create } from "zustand";
import type { McpServerConfig } from "@opc/shared";
import * as api from "../api/client.js";

export interface McpApprovalSummary {
  serverId: string;
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  url: string | null;
  envNames: string[];
  envValueHashes: Record<string, string>;
  workspaceHash: string;
  descriptorHash: string;
  bindingHash: string;
  approvedAt?: string;
  expiresAt?: string;
}

export interface McpApprovalResponse {
  ok: true;
  required: boolean;
  approval: McpApprovalSummary;
}

interface McpStore {
  servers: McpServerConfig[];
  loading: boolean;
  load: () => Promise<void>;
  create: (s: McpServerConfig) => Promise<McpServerConfig>;
  update: (id: string, patch: Partial<McpServerConfig>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  test: (id: string) => Promise<{ ok: boolean; message: string }>;
  approve: (id: string, confirmationToken?: string) => Promise<McpApprovalResponse>;
}

export const useMcpStore = create<McpStore>((set) => ({
  servers: [],
  loading: false,

  load: async () => {
    set({ loading: true });
    try {
      const servers = await api.get<McpServerConfig[]>("/mcp");
      set({ servers, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  create: async (s) => {
    const created = await api.post<McpServerConfig>("/mcp", s);
    set(st => ({ servers: [...st.servers, created] }));
    return created;
  },

  update: async (id, patch) => {
    const updated = await api.patch<McpServerConfig>(`/mcp/${id}`, patch);
    set(s => ({ servers: s.servers.map(sv => sv.id === id ? updated : sv) }));
  },

  remove: async (id) => {
    await api.del(`/mcp/${id}`);
    set(s => ({ servers: s.servers.filter(sv => sv.id !== id) }));
  },

  test: async (id) => {
    return api.post<{ ok: boolean; message: string }>(`/mcp/${id}/test`, {});
  },

  approve: async (id, confirmationToken) => {
    return api.post<McpApprovalResponse>(`/mcp/${id}/confirm`, confirmationToken ? { confirmationToken } : {});
  },
}));
