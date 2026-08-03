import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  freezeProducerManifestEntries,
  loadProducerManifest,
  latestProducerEntriesByPath,
} from "./producerManifestStore.js";

// MUP Gate A#1 · ProducerArtifactManifest 冻结规格:schemaVersion "1",落 .opc/runs/<runId>/
// producer-manifest.json;path=相对 workRoot POSIX(保留大小写),hash=实文件 sha256 全量小写 hex;
// append-only(同 path 追加新条目,消费方取最新);读不到的文件如实跳过,绝不虚构。

let root: string;
let workRoot: string;
const RUN = "run-pm-test";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-pmstore-"));
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opc-pmwork-"));
});
afterEach(() => {
  for (const d of [root, workRoot]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* Windows 文件锁 */ }
  }
});

function writeWork(rel: string, content: string): string {
  const abs = path.join(workRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
  return createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex");
}

describe("freezeProducerManifestEntries — 即时冻结", () => {
  it("冻结条目:path 保留大小写的 POSIX,hash=sha256 全量小写 hex(64),带 agentId/role/mergedAt;落盘 .opc/runs/<runId>/producer-manifest.json", () => {
    const expected = writeWork("src/Sum.js", "module.exports=(a,b)=>a+b;");
    const appended = freezeProducerManifestEntries(root, RUN, workRoot, [
      { path: "src\\Sum.js", agentId: "dev-1", role: "dev" },
    ], "2026-07-13T00:00:00.000Z");

    expect(appended).toHaveLength(1);
    expect(appended[0]).toEqual({
      path: "src/Sum.js", // 反斜杠归一为 POSIX,大小写保留
      hash: expected,
      agentId: "dev-1",
      role: "dev",
      mergedAt: "2026-07-13T00:00:00.000Z",
    });
    expect(appended[0].hash).toMatch(/^[0-9a-f]{64}$/);

    const onDisk = JSON.parse(fs.readFileSync(path.join(root, ".opc", "runs", RUN, "producer-manifest.json"), "utf-8"));
    expect(onDisk.schemaVersion).toBe("1");
    expect(onDisk.runId).toBe(RUN);
    expect(onDisk.entries).toEqual(appended);
  });

  it("append-only:同 path 后续轮次追加新条目(不覆盖),消费方经 latestProducerEntriesByPath 取最新", () => {
    const h1 = writeWork("app.js", "v1");
    freezeProducerManifestEntries(root, RUN, workRoot, [{ path: "app.js", agentId: "dev-1", role: "dev" }]);
    const h2 = writeWork("app.js", "v2-revised");
    freezeProducerManifestEntries(root, RUN, workRoot, [{ path: "app.js", agentId: "dev-2", role: "dev" }]);

    const m = loadProducerManifest(root, RUN)!;
    expect(m.entries).toHaveLength(2);
    expect(m.entries[0].hash).toBe(h1);
    expect(m.entries[1].hash).toBe(h2);

    const latest = latestProducerEntriesByPath(m.entries);
    expect(latest.size).toBe(1);
    expect(latest.get("app.js")!.hash).toBe(h2);
    expect(latest.get("app.js")!.agentId).toBe("dev-2");
  });

  it("读不到的文件如实跳过(不虚构 hash);越界路径(../ / 绝对)拒收", () => {
    const ok = writeWork("real.css", "body{}");
    const appended = freezeProducerManifestEntries(root, RUN, workRoot, [
      { path: "real.css", agentId: "dev-1", role: "dev" },
      { path: "ghost.js", agentId: "dev-1", role: "dev" },          // workRoot 里不存在
      { path: "../escape.js", agentId: "dev-1", role: "dev" },      // 越界
      { path: path.join(workRoot, "real.css"), agentId: "dev-1", role: "dev" }, // 绝对路径
    ]);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ path: "real.css", hash: ok });
  });

  it("全部不可冻结 → 不写盘(不留空清单)", () => {
    const appended = freezeProducerManifestEntries(root, RUN, workRoot, [
      { path: "missing.js", agentId: "dev-1", role: "dev" },
    ]);
    expect(appended).toEqual([]);
    expect(fs.existsSync(path.join(root, ".opc", "runs", RUN, "producer-manifest.json"))).toBe(false);
  });
});

describe("loadProducerManifest — 读回与形状校验", () => {
  it("清单缺失 → null", () => {
    expect(loadProducerManifest(root, "no-such-run")).toBeNull();
  });

  it("schemaVersion 不是 \"1\" 或 entries 非数组 → null(不硬吃未知形状)", () => {
    const dir = path.join(root, ".opc", "runs", RUN);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "producer-manifest.json"), JSON.stringify({ schemaVersion: "2", runId: RUN, entries: [] }), "utf-8");
    expect(loadProducerManifest(root, RUN)).toBeNull();
    fs.writeFileSync(path.join(dir, "producer-manifest.json"), JSON.stringify({ schemaVersion: "1", runId: RUN, entries: "nope" }), "utf-8");
    expect(loadProducerManifest(root, RUN)).toBeNull();
  });
});

describe("latestProducerEntriesByPath — 大小写不敏感取最新", () => {
  it("同 path 不同大小写归并为一个 key(小写查询命中),取最后追加者", () => {
    const latest = latestProducerEntriesByPath([
      { path: "Lib/Util.js", hash: "a".repeat(64), agentId: "a", role: "dev", mergedAt: "t1" },
      { path: "lib/UTIL.js", hash: "b".repeat(64), agentId: "b", role: "dev", mergedAt: "t2" },
    ]);
    expect(latest.size).toBe(1);
    expect(latest.get("lib/util.js")!.agentId).toBe("b");
  });
});
