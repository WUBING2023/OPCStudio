import * as fs from "node:fs";
import * as path from "node:path";

// P6 真隔离 · 磁盘配额看门狗(引擎无关):判断 dir 的总字节是否超过 limit
// (短路:一超过立即返回 true,不扫完整棵树,避免巨树扫描卡死)。
export function dirSizeExceeds(dir: string, limit: number): boolean {
  let total = 0, guard = 0;
  const stack: string[] = [dir];
  while (stack.length && guard++ < 20000) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { total += fs.statSync(p).size; if (total > limit) return true; } catch { /* skip */ } }
    }
  }
  return total > limit;
}
