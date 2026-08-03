import { describe, it, expect } from "vitest";
import { isLicenseAllowed } from "./communityStore.js";
import { DEFAULT_ALLOWED_LICENSES } from "@opc/shared";

// v3 A4：License 合规白名单逻辑（fail-closed）。
describe("isLicenseAllowed — License 合规白名单", () => {
  it("白名单内的宽松开源 License 通过", () => {
    expect(isLicenseAllowed("MIT")).toBe(true);
    expect(isLicenseAllowed("Apache-2.0")).toBe(true);
    expect(isLicenseAllowed("OPC-Original")).toBe(true); // OPC 自有原创内容
  });
  it("未知/缺失/NOASSERTION 一律 fail-closed", () => {
    expect(isLicenseAllowed(undefined)).toBe(false);
    expect(isLicenseAllowed("")).toBe(false);
    expect(isLicenseAllowed("NOASSERTION")).toBe(false);     // GitHub 对未识别 license 的返回
    expect(isLicenseAllowed("GPL-3.0")).toBe(false);          // copyleft 不在默认白名单
    expect(isLicenseAllowed("Proprietary")).toBe(false);
  });
  it("可传入自定义白名单覆盖默认", () => {
    expect(isLicenseAllowed("GPL-3.0", ["GPL-3.0"])).toBe(true);
    expect(isLicenseAllowed("MIT", ["GPL-3.0"])).toBe(false);
  });
  it("默认白名单含常见宽松 License", () => {
    for (const l of ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC", "Unlicense"]) {
      expect(DEFAULT_ALLOWED_LICENSES).toContain(l);
    }
  });
});
