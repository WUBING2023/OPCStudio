import { create } from "zustand";
import type { SkillMeta, Skill } from "@opc/shared";
import * as api from "../api/client.js";

interface SkillStore {
  skills: SkillMeta[];
  current: Skill | null;
  loading: boolean;
  load: () => Promise<void>;
  loadOne: (id: string) => Promise<void>;
  create: (data: { title: string; role: string; content: string }) => Promise<Skill>;
  update: (id: string, patch: Partial<Skill>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  toggle: (id: string) => Promise<void>;
  clearCurrent: () => void;
}

export const useSkillStore = create<SkillStore>((set, get) => ({
  skills: [],
  current: null,
  loading: false,

  load: async () => {
    set({ loading: true });
    try {
      const skills = await api.get<SkillMeta[]>("/skills");
      set({ skills, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  loadOne: async (id) => {
    try {
      const skill = await api.get<Skill>(`/skills/${id}`);
      set({ current: skill });
    } catch (e) {
      // 不完全静默:调用方(SkillsPage handleView)之后无条件 setViewId,如果这里失败且不留痕迹,
      // 用户点"查看"会看起来毫无反应且无法排查——至少留一条 console.error。
      console.error(`加载技能 ${id} 失败:`, e);
    }
  },

  create: async (data) => {
    const created = await api.post<Skill>("/skills", { ...data, enabled: true });
    set(s => ({ skills: [...s.skills, created] }));
    return created;
  },

  update: async (id, patch) => {
    const updated = await api.patch<Skill>(`/skills/${id}`, patch);
    set(s => ({
      skills: s.skills.map(sk => sk.id === id ? updated : sk),
      current: s.current?.id === id ? updated : s.current,
    }));
  },

  remove: async (id) => {
    await api.del(`/skills/${id}`);
    set(s => ({ skills: s.skills.filter(sk => sk.id !== id), current: s.current?.id === id ? null : s.current }));
  },

  toggle: async (id) => {
    const updated = await api.post<Skill>(`/skills/${id}/toggle`, {});
    set(s => ({
      skills: s.skills.map(sk => sk.id === id ? updated : sk),
      current: s.current?.id === id ? updated : s.current,
    }));
  },

  clearCurrent: () => set({ current: null }),
}));
