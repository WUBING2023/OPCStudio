import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// P1-18:导出公司为模板的按钮必须先过确认弹窗(说明服务端自动移除密钥/本地路径 + 就地确认
// 「导出时一并带上记忆」开关),确认后才真正发起导出。组件无 DOM 测试基建(纯 node vitest),
// 沿用 briefingPanelCeoScope.test.ts 的源码契约做法锁住这个不变量。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIALOG_SRC = fs.readFileSync(path.join(HERE, "ExportConfirmDialog.tsx"), "utf-8");
const FORMS_SRC = fs.readFileSync(path.join(HERE, "CompanyStructureForms.tsx"), "utf-8");
const DICTS = JSON.parse(
  fs.readFileSync(path.join(HERE, "..", "..", "i18n.dict.json"), "utf-8"),
) as Record<string, Record<string, string>>;

const NEW_KEYS = ["cmp.export.confirmTitle", "cmp.export.autoRemoveHint", "cmp.export.confirmButton"];
// 分场景导出档位(full=自己备份保真 / share=社区分享全脱敏,缺省 share)的五个词典键。
const PROFILE_KEYS = [
  "cmp.export.profileLabel",
  "cmp.export.profileShare",
  "cmp.export.profileShareHint",
  "cmp.export.profileFull",
  "cmp.export.profileFullHint",
];

describe("ExportConfirmDialog · 导出前确认(P1-18)", () => {
  it("三个新词典键在 en / zh-CN 均非空", () => {
    for (const lang of ["en", "zh-CN"]) {
      for (const key of NEW_KEYS) {
        expect(DICTS[lang]?.[key], `${lang} 缺 ${key}`).toBeTruthy();
      }
    }
  });

  it("confirmTitle 保留 {name} 占位符", () => {
    expect(DICTS.en["cmp.export.confirmTitle"]).toContain("{name}");
    expect(DICTS["zh-CN"]["cmp.export.confirmTitle"]).toContain("{name}");
  });

  it("弹窗组件三个新键 + 复用的 memoryExportEnabled 两键都被引用(不是硬编码文案)", () => {
    for (const key of [...NEW_KEYS, "cmp.memoryExportEnabled", "cmp.memoryExportEnabledHint", "common.cancel"]) {
      expect(DIALOG_SRC, `ExportConfirmDialog 未使用键 ${key}`).toContain(`"${key}"`);
    }
  });

  it("弹窗内的记忆开关初始值来自 initialMemoryEnabled(不是写死 true/false)", () => {
    expect(DIALOG_SRC).toMatch(/useState\(initialMemoryEnabled\)/);
  });

  it("弹窗未确认时不发起导出:onConfirm 只回传 memoryEnabled,不直接调用 api", () => {
    expect(DIALOG_SRC).not.toMatch(/api\.(get|patch)/);
  });

  it("CompanyStructureForms:导出按钮打开确认弹窗,不直接调用 exportTemplate", () => {
    expect(FORMS_SRC).toMatch(/onClick=\{\(\)\s*=>\s*setExportConfirmOpen\(true\)\}/);
    expect(FORMS_SRC).not.toMatch(/onClick=\{exportTemplate\}/);
  });

  it("CompanyStructureForms:真正的导出请求只挂在 ExportConfirmDialog 的 onConfirm 上", () => {
    const dialogBlock = FORMS_SRC.slice(FORMS_SRC.indexOf("<ExportConfirmDialog"), FORMS_SRC.indexOf("<ExportConfirmDialog") + 400);
    expect(dialogBlock).toMatch(/onConfirm=\{exportTemplate\}/);
  });

  it("exportTemplate 与当前公司 memoryExportEnabled 不同才 PATCH,再 GET 导出(带 profile 参数)", () => {
    const fnStart = FORMS_SRC.indexOf("const exportTemplate = async");
    const fnBody = FORMS_SRC.slice(fnStart, fnStart + 900);
    expect(fnBody).toMatch(/api\.patch<Company>\(`\/companies\/\$\{company\.id\}`,\s*\{\s*memoryExportEnabled\s*\}\)/);
    expect(fnBody).toMatch(/api\.get<CompanyTemplate>\(`\/companies\/\$\{company\.id\}\/export\?profile=\$\{profile\}`\)/);
    expect(fnBody.indexOf("api.patch")).toBeLessThan(fnBody.indexOf("api.get<CompanyTemplate>"));
  });

  // ── 分场景导出档位(full 自己备份 / share 社区分享)──────────────────────────
  describe("导出档位选择(full/share)", () => {
    it("五个档位词典键在 en / zh-CN 均非空", () => {
      for (const lang of ["en", "zh-CN"]) {
        for (const key of PROFILE_KEYS) {
          expect(DICTS[lang]?.[key], `${lang} 缺 ${key}`).toBeTruthy();
        }
      }
    });

    it("弹窗引用全部档位键(不是硬编码文案)", () => {
      for (const key of PROFILE_KEYS) {
        expect(DIALOG_SRC, `ExportConfirmDialog 未使用键 ${key}`).toContain(`"${key}"`);
      }
    });

    it("档位缺省为 share(偏安全的一档),不是 full", () => {
      expect(DIALOG_SRC).toMatch(/useState<ExportProfile>\("share"\)/);
    });

    it("full 档展示显式警示(profileFullHint + 警示图标),share 档是普通说明", () => {
      expect(DIALOG_SRC).toContain("AlertTriangle");
      const fullBranch = DIALOG_SRC.indexOf('profile === "full"');
      expect(fullBranch).toBeGreaterThan(-1);
      expect(DIALOG_SRC.slice(fullBranch, fullBranch + 500)).toContain("cmp.export.profileFullHint");
    });

    it("full 档警示文案点名「勿分享」(en: do NOT share / zh: 请勿分享)", () => {
      expect(DICTS.en["cmp.export.profileFullHint"]).toMatch(/do NOT share/i);
      expect(DICTS["zh-CN"]["cmp.export.profileFullHint"]).toContain("请勿分享");
    });

    it("onConfirm 回传所选档位,CompanyStructureForms 把 profile 拼进导出 URL", () => {
      expect(DIALOG_SRC).toMatch(/onConfirm\(memoryEnabled,\s*profile\)/);
      expect(FORMS_SRC).toMatch(/export\?profile=\$\{profile\}/);
    });
  });
});
