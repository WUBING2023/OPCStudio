import { create } from "zustand";
import type { EngineAvailability } from "@opc/shared";
import * as api from "../api/client.js";

const STORAGE_KEY = "opc-framework-availability-v1";

interface FrameworkAvailabilitySnapshot {
  frameworks: EngineAvailability[];
  lastCheckedAt: string;
}

interface FrameworkAvailabilityStore extends FrameworkAvailabilitySnapshot {
  hydrated: boolean;
  refreshing: boolean;
  error: string | null;
  hydrate: () => void;
  refresh: () => Promise<EngineAvailability[]>;
}

function isAvailability(value: unknown): value is EngineAvailability {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<EngineAvailability>;
  return typeof item.framework === "string"
    && typeof item.installed === "boolean"
    && typeof item.loggedIn === "boolean"
    && typeof item.version === "string";
}

export function parseFrameworkAvailabilitySnapshot(raw: string | null): FrameworkAvailabilitySnapshot | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<FrameworkAvailabilitySnapshot>;
    if (!Array.isArray(value.frameworks) || !value.frameworks.every(isAvailability)) return null;
    if (typeof value.lastCheckedAt !== "string") return null;
    return { frameworks: value.frameworks, lastCheckedAt: value.lastCheckedAt };
  } catch {
    return null;
  }
}

function persistSnapshot(snapshot: FrameworkAvailabilitySnapshot): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Electron/browser storage can be unavailable in hardened contexts; runtime state still works.
  }
}

export const useFrameworkAvailabilityStore = create<FrameworkAvailabilityStore>((set, get) => ({
  frameworks: [],
  lastCheckedAt: "",
  hydrated: false,
  refreshing: false,
  error: null,
  hydrate: () => {
    if (get().hydrated) return;
    const cached = parseFrameworkAvailabilitySnapshot(
      typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY),
    );
    if (cached) {
      set({ ...cached, hydrated: true });
      return;
    }
    set({ hydrated: true });
    void get().refresh();
  },
  refresh: async () => {
    if (get().refreshing) return get().frameworks;
    set({ refreshing: true, error: null });
    try {
      const response = await api.get<{ frameworks: EngineAvailability[] }>("/frameworks");
      const frameworks = Array.isArray(response.frameworks)
        ? response.frameworks.filter(isAvailability)
        : [];
      const snapshot = { frameworks, lastCheckedAt: new Date().toISOString() };
      persistSnapshot(snapshot);
      set({ ...snapshot, error: null });
      return frameworks;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      set({ refreshing: false });
    }
  },
}));
