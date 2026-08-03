import * as path from "node:path";
import { readJSON, writeJSON } from "./jsonFile.js";

export type ModelCatalogRefreshSource = "live" | "acp";

export interface ModelCatalogRefreshRecord {
  kind: "provider" | "subscription";
  id: string;
  models: Array<{ id: string; label: string; isDefault?: boolean }>;
  source: ModelCatalogRefreshSource;
  refreshedAt: string;
}

interface ModelCatalogRefreshState {
  version: 1;
  records: Record<string, ModelCatalogRefreshRecord>;
}

function statePath(projectRoot: string): string {
  return path.join(projectRoot, ".opc", "model-catalog-state.json");
}

function key(kind: ModelCatalogRefreshRecord["kind"], id: string): string {
  return `${kind}:${id}`;
}

export function loadModelCatalogRefreshRecord(
  projectRoot: string,
  kind: ModelCatalogRefreshRecord["kind"],
  id: string,
): ModelCatalogRefreshRecord | undefined {
  const state = readJSON<ModelCatalogRefreshState>(statePath(projectRoot), { version: 1, records: {} });
  return state.records[key(kind, id)];
}

export function saveModelCatalogRefreshRecord(projectRoot: string, record: ModelCatalogRefreshRecord): void {
  const file = statePath(projectRoot);
  const state = readJSON<ModelCatalogRefreshState>(file, { version: 1, records: {} });
  state.records[key(record.kind, record.id)] = record;
  writeJSON(file, state);
}
