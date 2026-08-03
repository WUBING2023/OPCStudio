import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureStoreMeta, UnsupportedStoreVersionError, CURRENT_STORE_VERSION } from "./metaStore.js";

describe(".opc 目录版本戳(meta.json)", () => {
  let root: string;
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("meta.json 不存在 → 创建,storeVersion=当前支持值,含 createdAt", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "meta-"));
    const meta = ensureStoreMeta(root);
    expect(meta.storeVersion).toBe(CURRENT_STORE_VERSION);
    expect(typeof meta.createdAt).toBe("string");
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, ".opc", "meta.json"), "utf-8"));
    expect(onDisk).toEqual(meta);
  });

  it("meta.json 已存在且版本可识别 → 原样返回,不改写 createdAt", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "meta-"));
    const dir = path.join(root, ".opc");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ storeVersion: 1, createdAt: "2020-01-01T00:00:00.000Z" }));
    const meta = ensureStoreMeta(root);
    expect(meta).toEqual({ storeVersion: 1, createdAt: "2020-01-01T00:00:00.000Z" });
  });

  it("meta.json storeVersion 高于当前支持值 → 抛 UnsupportedStoreVersionError", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "meta-"));
    const dir = path.join(root, ".opc");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ storeVersion: 999, createdAt: "2020-01-01T00:00:00.000Z" }));
    expect(() => ensureStoreMeta(root)).toThrow(UnsupportedStoreVersionError);
    expect(() => ensureStoreMeta(root)).toThrow(/请升级/);
  });

  it("meta.json 损坏(JSON 解析失败)→ 视为不存在,重建为当前版本", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "meta-"));
    const dir = path.join(root, ".opc");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), '{"storeVersion":1,"crea');
    const meta = ensureStoreMeta(root);
    expect(meta.storeVersion).toBe(CURRENT_STORE_VERSION);
  });
});
