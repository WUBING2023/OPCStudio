import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 安装确认弹窗 / 社区页的源码契约测试(纯 node vitest,组件无 DOM 测试基建,沿用
// exportConfirmDialog.test.ts 的做法):锁住 retainHighRisk 勾选 + 一次性 installConfirmationToken
// 两步流门控(令四.1)、trustLevel/hashVerified 渲染、撤销安装(rollback)与本地库下架的接线,
// 以及三处新词典键在 en/zh-CN 齐备。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIALOG = fs.readFileSync(path.join(HERE, "ImportConfirmDialog.tsx"), "utf-8");
const PAGE = fs.readFileSync(path.join(HERE, "..", "pages", "CommunityPage.tsx"), "utf-8");
const DICTS = JSON.parse(fs.readFileSync(path.join(HERE, "..", "i18n.dict.json"), "utf-8")) as Record<string, Record<string, string>>;

const NEW_KEYS = [
  "ic.trust.label", "ic.trust.official", "ic.trust.verified_community", "ic.trust.community",
  "ic.trust.local_import", "ic.trust.untrusted", "ic.hashVerified", "ic.hashUnverified",
  "ic.keepDangerCheckbox", "ic.keepDangerNote",
  "c.installRecords", "c.recordsTitle", "c.recordsHint", "c.recordsEmpty",
  "c.recordModeNew", "c.recordModeMerge", "c.recordRollback", "c.recordRollingBack", "c.recordRolledBack",
  "c.rollbackConfirm", "c.rollbackDone", "c.rollbackFail",
  "c.unlist", "c.unlistConfirm", "c.unlistDone", "c.unlistFail",
];

// 令四.1:客户端布尔 unsafeAcknowledged 已废——勾选(retainHighRisk)只是 UI 选择,真正授权凭据是
// preview 阶段后端签发的一次性 installConfirmationToken,真装带回才启用 unsafe 保留。
describe("ImportConfirmDialog · retainHighRisk 勾选门控(令四.1 token 两步流)", () => {
  it("handleConfirm 只在勾选且确有可剥离项时带 retainHighRisk(本身不构成授权,由上层换成 token),否则不带(=Safe Install)", () => {
    expect(DIALOG).toMatch(
      /retainHighRisk:\s*retainHighRisk\s*&&\s*!!check\?\.safeInstallPreview\?\.length\s*\?\s*true\s*:\s*undefined/,
    );
  });

  it("勾选框受控于 retainHighRisk,onChange 回传 onRetainHighRiskChange", () => {
    expect(DIALOG).toMatch(/checked=\{retainHighRisk\}/);
    expect(DIALOG).toMatch(/onRetainHighRiskChange\(e\.target\.checked\)/);
  });

  it("勾选保留但预览 token 未就绪 → 确认按钮禁用(不发注定被服务端拒的请求)", () => {
    expect(DIALOG).toMatch(/needsInstallToken\s*=\s*retainHighRisk\s*&&\s*!!check\?\.safeInstallPreview\?\.length/);
    expect(DIALOG).toMatch(/needsInstallToken\s*&&\s*!hasInstallConfirmationToken/);
  });

  it("默认不勾:CommunityPage 打开新导入目标时复位 retainHighRisk,并作废上一个模板的 token", () => {
    expect(PAGE).toMatch(/setRetainHighRisk\(false\)/);
    expect(PAGE).toMatch(/setInstallConfirmationToken\(undefined\)/);
  });
});

describe("ImportConfirmDialog · trustLevel / hashVerified 渲染契约", () => {
  it("按拉取到的 trustLevel 渲染来源可信度徽标(带 label 键)", () => {
    expect(DIALOG).toContain("check.trustLevel");
    expect(DIALOG).toContain('tr("ic.trust.label")');
    expect(DIALOG).toContain("trustLabel(check.trustLevel)");
  });

  it("按 hashVerified 渲染完整性徽标(校验/未校验两文案)", () => {
    expect(DIALOG).toContain("check.hashVerified");
    expect(DIALOG).toContain('tr("ic.hashVerified")');
    expect(DIALOG).toContain('tr("ic.hashUnverified")');
  });

  it("Safe Install 剥离清单 + 「我知情并保留」勾选文案都用词典键(非硬编码)", () => {
    expect(DIALOG).toContain('tr("ic.keepDangerCheckbox")');
    expect(DIALOG).toContain('tr("ic.keepDangerNote")');
  });
});

describe("CommunityPage · rollback / 安装记录 / 下架 接线", () => {
  it("安装成功后把服务端 txId 落进本地安装记录", () => {
    expect(PAGE).toMatch(/if\s*\(r\.txId\)\s*store\.recordInstall\(\{\s*txId:\s*r\.txId/);
  });

  it("令四.1:勾选保留时把 preview 签发的一次性 token 换进请求(未勾/无 token 一律不带 → 服务端恒 Safe Install)", () => {
    expect(PAGE).toMatch(/tokenField\s*=\s*opts\.retainHighRisk\s*&&\s*installConfirmationToken\s*\?\s*\{\s*installConfirmationToken\s*\}\s*:\s*\{\s*\}/);
  });

  it("new-company 安装把 tokenField 透传给 store.installCompany;合并安装分支也随体带上", () => {
    expect(PAGE).toMatch(/store\.installCompany\(item\.id,\s*\{\s*\.\.\.tokenField,\s*\.\.\.planField\s*\}\)/);
    expect(PAGE).toMatch(/\.\.\.tokenField/);
  });

  it("安装记录弹窗真的被渲染(showRecords 有消费方,不是死开关)", () => {
    expect(PAGE).toMatch(/\{showRecords\s*&&/);
    expect(PAGE).toContain('tr("c.recordsTitle")');
    expect(PAGE).toContain('tr("c.recordsEmpty")');
  });

  it("记录行的撤销按钮走 handleRollback,handleRollback 调 store.rollbackInstall", () => {
    expect(PAGE).toMatch(/handleRollback\(rec\.txId\)/);
    expect(PAGE).toMatch(/store\.rollbackInstall\(txId\)/);
  });

  it("本地库下架入口 UnlistBtn 走 handleUnlist,handleUnlist 调 store.unlistLocal", () => {
    expect(PAGE).toContain("handleUnlist(store.contentType, id)");
    expect(PAGE).toMatch(/store\.unlistLocal\(type,\s*id\)/);
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

  it("带占位符的键保留 {msg} / {n}", () => {
    for (const lang of ["en", "zh-CN"]) {
      expect(DICTS[lang]["c.rollbackFail"]).toContain("{msg}");
      expect(DICTS[lang]["c.unlistFail"]).toContain("{msg}");
    }
  });
});
