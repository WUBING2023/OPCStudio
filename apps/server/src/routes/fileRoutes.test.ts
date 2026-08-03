import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { isSensitive, safeResolve } from "./fileRoutes.js";

// 文件管理器 sandbox 安全单测(董事长强调的红线:密钥/凭证绝不可被读到)。
describe("fileRoutes sandbox", () => {
  describe("isSensitive — 敏感文件/目录一律拦截", () => {
    it("敏感目录段:keys / .git / node_modules", () => {
      expect(isSensitive("keys/deepseek.key")).toBe(true);
      expect(isSensitive("apps/keys/x.txt")).toBe(true);
      expect(isSensitive(".git/config")).toBe(true);
      expect(isSensitive("node_modules/pkg/index.js")).toBe(true);
    });
    it("敏感文件名:.env / auth.json / .opc 配置", () => {
      expect(isSensitive(".env")).toBe(true);
      expect(isSensitive("apps/server/.env")).toBe(true);
      expect(isSensitive("auth.json")).toBe(true);
      expect(isSensitive(".opc/config.json")).toBe(true);
      expect(isSensitive(".opc/accounts.json")).toBe(true);
      expect(isSensitive(".opc/providers.json")).toBe(true);
      expect(isSensitive(".opc/github_oauth.json")).toBe(true); // GitHub OAuth accessToken 明文存这
    });
    it("敏感扩展名 / 凭证类 json", () => {
      expect(isSensitive("certs/server.key")).toBe(true);
      expect(isSensitive("a/b/private.pem")).toBe(true);
      expect(isSensitive("secret-tokens.json")).toBe(true);
      expect(isSensitive(".ssh/id_rsa")).toBe(true);
    });
    it("正常文件放行", () => {
      expect(isSensitive("docs/revised-roadmap.md")).toBe(false);
      expect(isSensitive("apps/web/src/App.tsx")).toBe(false);
      expect(isSensitive("package.json")).toBe(false);
      expect(isSensitive(".opc/config.example.json")).toBe(false); // 示例非密钥
      expect(isSensitive(".opc/runs/abc/report.md")).toBe(false);
      expect(isSensitive(".opc/knowledge/company.md")).toBe(false);
    });
  });

  describe("safeResolve — 必须留在 projectRoot 子树内", () => {
    const root = path.resolve("/proj/root");
    it("正常相对路径解析在内", () => {
      const r = safeResolve(root, "src/a.ts");
      expect(r).not.toBeNull();
      expect(r!.startsWith(root)).toBe(true);
    });
    it("'.' 解析为根本身", () => {
      expect(safeResolve(root, ".")).toBe(root);
    });
    it("越界路径被拒(返回 null)", () => {
      expect(safeResolve(root, "..")).toBeNull();
      expect(safeResolve(root, "../sibling")).toBeNull();
      expect(safeResolve(root, "../../etc/passwd")).toBeNull();
    });
    it("前缀同名兄弟目录不被误判为子目录(/proj/root vs /proj/rootx)", () => {
      // 解析 "../rootx" 应越界(它在 /proj/rootx,不在 /proj/root 子树内)。
      expect(safeResolve(root, "../rootx/secret")).toBeNull();
    });
  });
});
