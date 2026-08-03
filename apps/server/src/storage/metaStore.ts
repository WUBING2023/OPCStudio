import * as path from "node:path";
import { readJSON, writeJSON } from "./jsonFile.js";

// .opc 目录版本戳:标记 .opc 存储 schema 的版本,为未来跨版本迁移(字段改名/目录结构调整等)留入口。
// 服务启动时确保 .opc/meta.json 存在;已存在则校验版本可识别 —— 磁盘版本高于当前程序支持的版本
// (旧程序打开了新版本写过的项目目录)时,数据可能带着本程序不认识的结构,贸然继续读写有损坏风险,
// 直接抛出阻止启动,提示用户升级,而不是静默按旧 schema 误读。
//
// 战役B·Phase B2a 说明(刻意不接后端开关):meta.json 是 .opc 目录的**引导版本闸**,是"该用哪个后端 / 库
// 结构是否兼容"的先决判定,必须先于、且独立于后端选择即可读——因此计划 §0.1 明确 meta.json 两个后端下都
// 保持 JSON、不迁 SQLite(schema.ts 无 meta 表)。所以本 store 在 json/sqlite 两种后端下行为逐字节一致
// (参数化双后端单测据此各跑一遍即等价),高版本拒开机制原样保留。cutover 时才 CURRENT_STORE_VERSION 1→2。
export const CURRENT_STORE_VERSION = 1;

export interface StoreMeta {
  storeVersion: number;
  createdAt: string;
}

function metaPath(root: string): string {
  return path.join(root, ".opc", "meta.json");
}

export class UnsupportedStoreVersionError extends Error {
  constructor(public readonly diskVersion: number) {
    super(
      `.opc 目录版本 (storeVersion=${diskVersion}) 高于当前程序支持的版本 (${CURRENT_STORE_VERSION})，请升级 OPC Studio 后再打开该项目。`,
    );
    this.name = "UnsupportedStoreVersionError";
  }
}

/**
 * 启动时调用:确保 .opc/meta.json 存在且 storeVersion 可识别。
 * - 不存在 / 无法解析出合法 storeVersion → 写入当前版本的新 meta。
 * - 存在且 storeVersion <= 当前支持值 → 原样返回,不重写(保留原 createdAt)。
 * - 存在且 storeVersion > 当前支持值 → 抛 UnsupportedStoreVersionError,调用方据此阻止启动。
 */
export function ensureStoreMeta(root: string): StoreMeta {
  const p = metaPath(root);
  const existing = readJSON<Partial<StoreMeta> | null>(p, null);
  if (existing && typeof existing.storeVersion === "number" && Number.isFinite(existing.storeVersion)) {
    if (existing.storeVersion > CURRENT_STORE_VERSION) {
      throw new UnsupportedStoreVersionError(existing.storeVersion);
    }
    return {
      storeVersion: existing.storeVersion,
      createdAt: typeof existing.createdAt === "string" ? existing.createdAt : new Date().toISOString(),
    };
  }
  const meta: StoreMeta = { storeVersion: CURRENT_STORE_VERSION, createdAt: new Date().toISOString() };
  writeJSON(p, meta);
  return meta;
}
