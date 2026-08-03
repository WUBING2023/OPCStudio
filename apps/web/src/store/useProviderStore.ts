import { create } from "zustand";
import type { ProviderConfig } from "@opc/shared";
import * as api from "../api/client.js";

interface ProviderStore {
  providers: ProviderConfig[];
  loading: boolean;
  selectedId: string | null;
  load: () => Promise<void>;
  select: (id: string | null) => void;
  create: (p: ProviderConfig) => Promise<ProviderConfig>;
  update: (id: string, patch: Partial<ProviderConfig>) => Promise<ProviderConfig>;
  remove: (id: string) => Promise<void>;
}

export const useProviderStore = create<ProviderStore>((set, get) => ({
  providers: [],
  loading: false,
  selectedId: null,

  load: async () => {
    set({ loading: true });
    try {
      const providers = await api.get<ProviderConfig[]>("/providers");
      set({ providers, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  select: (id) => set({ selectedId: id }),

  create: async (p) => {
    const created = await api.post<ProviderConfig>("/providers", p);
    set(s => ({ providers: [...s.providers, created] }));
    return created;
  },

  update: async (id, patch) => {
    const updated = await api.patch<ProviderConfig>(`/providers/${id}`, patch);
    set(s => ({ providers: s.providers.map(p => p.id === id ? updated : p) }));
    return updated;
  },

  remove: async (id) => {
    await api.del(`/providers/${id}`);
    set(s => ({ providers: s.providers.filter(p => p.id !== id) }));
  },
}));
