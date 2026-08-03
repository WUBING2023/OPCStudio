// 令五.5 · shell:true 清零回归卫士。扫描 apps/server/src 全部非测试源码,任何 `shell: true` /
// `shell: process.platform` 的**真实代码**(非注释)出现点都必须携带豁免标记 `shell-exempt`(同行或前 4 行
// 注释内),否则本测试红。目的:新增一处未经审计的 shell:true 立刻被拦下——shell:true 在 Windows 上把整条
// 命令交给 cmd.exe 解析,既有 argv 不转义(DEP0190)风险又扩大注入面。当前预期:server 域清零(0 处),
// 三处历史点(acpWorkerBackend / subscriptionChatPool / setupRoutes)已全部迁到 shell:false + 参数数组。
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = path.resolve(__dirname, "../.."); // engines → runtime → src

const SHELL_RE = /shell\s*:\s*(?:true|process\.platform)/;
const EXEMPT_MARKER = "shell-exempt";

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === "dist" || ent.name === "__fixtures__") continue;
      out.push(...listTsFiles(full));
    } else if (ent.isFile() && ent.name.endsWith(".ts") && !ent.name.endsWith(".test.ts") && !ent.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

// 判断 match 是否落在行内 `//` 注释里:找到该行第一个 `//`,若它在 match 之前(且不是 URL 里的 `://`),即为注释。
function isCommentedAt(line: string, matchIndex: number): boolean {
  const slash = line.indexOf("//");
  if (slash === -1 || slash > matchIndex) return false;
  // 排除 `https://` 这类:`//` 前一个字符是 `:` 且更前面像 scheme,粗判——本仓真实代码里不会出现这种在 shell 选项前的 URL。
  if (slash > 0 && line[slash - 1] === ":") return false;
  return true;
}

describe("令五.5 · shell:true 清零卫士(apps/server/src)", () => {
  const files = listTsFiles(SERVER_SRC);

  it("扫描到了 server 源码文件(walker 未空跑)", () => {
    expect(files.length).toBeGreaterThan(50);
    // 三处迁移点必须在扫描范围内(否则卫士形同虚设)
    const rels = files.map((f) => path.relative(SERVER_SRC, f).replace(/\\/g, "/"));
    expect(rels).toContain("runtime/engines/acpWorkerBackend.ts");
    expect(rels).toContain("runtime/subscriptionChatPool.ts");
    expect(rels).toContain("routes/setupRoutes.ts");
  });

  it("任何真实 shell:true / shell:process.platform 都必须带 shell-exempt 豁免标记", () => {
    const violations: string[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = SHELL_RE.exec(lines[i]);
        if (!m) continue;
        if (isCommentedAt(lines[i], m.index)) continue; // 注释里提到 shell:true 不算
        // 真实代码出现点 → 需豁免标记(同行或前 4 行)
        const window = lines.slice(Math.max(0, i - 4), i + 1).join("\n");
        if (!window.includes(EXEMPT_MARKER)) {
          violations.push(`${path.relative(SERVER_SRC, file).replace(/\\/g, "/")}:${i + 1}  ${lines[i].trim()}`);
        }
      }
    }
    expect(violations, `未豁免的 shell:true 出现点:\n${violations.join("\n")}`).toEqual([]);
  });

  it("三处迁移点确已改用 shell:false(防回归)", () => {
    // 剥离注释后再断言,避免匹配到迁移注释里的字面 "shell:false"(finding 3-2:断言过弱)——
    // 行注释 // ... 与块注释 /* ... */ 都去掉,只在真实代码上找 `shell: false`。
    const stripComments = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const rel of ["runtime/engines/acpWorkerBackend.ts", "runtime/subscriptionChatPool.ts", "routes/setupRoutes.ts"]) {
      const code = stripComments(fs.readFileSync(path.join(SERVER_SRC, rel), "utf-8"));
      expect(code, `${rel} 真实代码应含 shell: false`).toMatch(/shell:\s*false/);
    }
  });
});
