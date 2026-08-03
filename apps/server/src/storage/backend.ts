import * as path from "node:path";
import { readJSON } from "./jsonFile.js";

// 战役B·Phase B0:存储后端开关。后续各 store 保持导出签名不变,内部按本开关走 JSON 或 SQLite 实现;
// 双写过渡期翻回 "json" 即整体回退,零数据损失(SQLite 为读权威时 JSON 仍照写)。
// 优先级:env OPC_STORAGE_BACKEND > config.json 的 storageBackend 字段 > 默认 "sqlite"。
// - env 用于单进程试跑/测试参数化,不落盘;config 用于项目级持久开关。
// - config.json 里 storageBackend 目前是读侧宽容字段(ProjectConfig 类型暂无此键,B0 不改 shared 类型);
//   非法值一律按默认 "sqlite" 处理,不抛错——开关坏了不该让系统起不来。

export type StorageBackend = "json" | "sqlite";

export const STORAGE_BACKEND_ENV = "OPC_STORAGE_BACKEND";
export const DEFAULT_STORAGE_BACKEND: StorageBackend = "sqlite";

function parseBackend(v: unknown): StorageBackend | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return s === "json" || s === "sqlite" ? (s as StorageBackend) : null;
}

export function resolveStorageBackend(projectRoot: string): StorageBackend {
  const fromEnv = parseBackend(process.env[STORAGE_BACKEND_ENV]);
  if (fromEnv) return fromEnv;
  const cfg = readJSON<Record<string, unknown> | null>(
    path.join(projectRoot, ".opc", "config.json"),
    null,
  );
  const fromConfig = parseBackend(cfg?.storageBackend);
  if (fromConfig) return fromConfig;
  return DEFAULT_STORAGE_BACKEND;
}

export function isSqliteBackend(projectRoot: string): boolean {
  return resolveStorageBackend(projectRoot) === "sqlite";
}
