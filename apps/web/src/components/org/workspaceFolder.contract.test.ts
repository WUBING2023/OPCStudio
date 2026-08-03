import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 收口③ · 工作目录设置 V0 —— 前端契约测试(纯 node vitest,组件无 DOM 测试基建,沿用
// importConfirmUnsafeAck.contract.test.ts 的源码正则做法):锁住主工作目录 UI 走对 API 的接线——
// ① 绑定/清除只打专用端点 POST /companies/:id/folder(不得经通用 PATCH 旁路);
// ② 非 Git 目录的 409 → 显式确认弹窗 → 确认后才带 initAsManagedWorkspace(零静默初始化);
// ③ 导入/恢复/社区安装三条落地路径都有"需重新绑定本机工作目录"提示;
// ④ 新词典键在 en / zh-CN 齐备。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FORMS = fs.readFileSync(path.join(HERE, "CompanyStructureForms.tsx"), "utf-8");
const INSTALL_MODAL = fs.readFileSync(path.join(HERE, "..", "community", "InstallResultModal.tsx"), "utf-8");
const DICTS = JSON.parse(fs.readFileSync(path.join(HERE, "..", "..", "i18n.dict.json"), "utf-8")) as Record<string, Record<string, string>>;

const NEW_KEYS = [
  "cmp.folder.title", "cmp.folder.hint", "cmp.folder.placeholder", "cmp.folder.bind",
  "cmp.folder.clear", "cmp.folder.unbound", "cmp.folder.rebindAfterImport",
  "cmp.folder.bound", "cmp.folder.cleared",
  "cmp.folder.initConfirmTitle", "cmp.folder.initConfirmBody", "cmp.folder.initConfirmOk",
];

describe("主工作目录 UI · 走对专用端点(不旁路通用 PATCH)", () => {
  it("绑定与清除都 POST /companies/:id/folder", () => {
    const calls = FORMS.match(/api\.post[^(]*\(\s*`\/companies\/\$\{company\.id\}\/folder`/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2); // bindFolder + clearFolder
  });

  it("清除 = 发空 folder(服务端按空串清除绑定)", () => {
    expect(FORMS).toMatch(/\/folder`,\s*\{\s*folder:\s*""\s*\}/);
  });

  it("folder 不进通用 PATCH:patchCompany 的调用点没有任何一处带 folder 字段", () => {
    const patchCalls = FORMS.match(/patchCompany\(\{[^}]*\}\)/g) ?? [];
    expect(patchCalls.length).toBeGreaterThan(0);
    for (const c of patchCalls) expect(c).not.toContain("folder");
  });
});

describe("主工作目录 UI · 非 Git 目录零静默初始化(409 → 显式确认)", () => {
  it("只在 409 时弹初始化确认,确认后才重发带 initAsManagedWorkspace", () => {
    expect(FORMS).toMatch(/e\?\.status === 409 && !initConfirmed/);
    expect(FORMS).toContain('tr("cmp.folder.initConfirmTitle")');
    expect(FORMS).toContain('tr("cmp.folder.initConfirmBody")');
    expect(FORMS).toMatch(/initConfirmed\s*\?\s*\{\s*folder:\s*v,\s*initAsManagedWorkspace:\s*true\s*\}\s*:\s*\{\s*folder:\s*v\s*\}/);
  });

  it("用户取消确认弹窗则不重发(if (yes) 门控)", () => {
    expect(FORMS).toMatch(/if\s*\(yes\)\s*\{\s*await bindFolder\(true\);/);
  });
});

describe("导入/恢复/社区安装 · 需重新绑定提示", () => {
  it("本地文件导入成功后提示重新绑定", () => {
    const importIdx = FORMS.indexOf('tr("cmp.backup.imported")');
    expect(importIdx).toBeGreaterThan(-1);
    expect(FORMS.slice(importIdx, importIdx + 400)).toContain('tr("cmp.folder.rebindAfterImport")');
  });

  it("备份恢复成功后提示重新绑定", () => {
    const restoreIdx = FORMS.indexOf('tr("cmp.backup.restored")');
    expect(restoreIdx).toBeGreaterThan(-1);
    expect(FORMS.slice(restoreIdx, restoreIdx + 400)).toContain('tr("cmp.folder.rebindAfterImport")');
  });

  it("社区安装完成弹层也提示重新绑定", () => {
    expect(INSTALL_MODAL).toContain('tr("cmp.folder.rebindAfterImport")');
  });

  it("未绑定态常显提示(BasicInfoTab 的 unbound 分支)", () => {
    expect(FORMS).toContain('tr("cmp.folder.unbound")');
  });
});

describe("i18n · 新词典键在 en / zh-CN 齐备", () => {
  it("每个新键在 en 与 zh-CN 都非空", () => {
    for (const lang of ["en", "zh-CN"]) {
      for (const key of NEW_KEYS) {
        expect(DICTS[lang]?.[key], `${lang} 缺 ${key}`).toBeTruthy();
      }
    }
  });
});
