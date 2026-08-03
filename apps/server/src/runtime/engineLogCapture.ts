// B1 遗留件 · 引擎子进程日志捕获:把 CLI 引擎(claude-code/codex/generic-cli/hermes)子进程的
// stdout/stderr 旁路 tee 进 .opc/runs/<runId>/logs/backend.{stdout,stderr}.log——run 目录契约
// (§5 B1)明列的缺件。与 runtimeContract.ts 同风格:纯 writer、显式 utf-8、全程 best-effort
// (目录建失败/写失败静默禁用,绝不影响引擎执行),不改任何解析/事件逻辑。
//
// 设计要点:
// · 按行缓冲:chunk 攒到换行才落盘,close() 刷掉最后的半行——引擎输出是任意切片的流,直接写
//   chunk 会把一行 JSON 切成多段,头部也没法按行加。
// · 每行过 redactSecrets:这些日志躺在 .opc/runs/ 里,会随 run 目录被分享/打包出去,CLI 的
//   stream-json 里可能回显 env/key 片段,和 events.jsonl 一样必须脱敏。
// · 行首头 [engineLabel agentId ts]:同一 run 的多个 agent(各自一个 sink)追加写同一对文件,
//   头部是唯一的归属线索。
// · 单文件 2MB 上限:防失控引擎(死循环刷屏)把磁盘写爆。超限写一行截断标记,之后全部丢弃。
//   多 sink 并发追加同一文件时各自在首写时 stat 一次现有大小、之后只计自己写的字节——是
//   "防失控"的软上限而非精确配额(并发下总量最多 N×2MB,仍有界)。
// · 无 runId/projectRoot(测试或独立调用)→ 整体 no-op,不建目录不写文件。
import * as fs from "node:fs";
import * as path from "node:path";
import { redactSecrets } from "../security/redact.js";
import { getEventPersistRoot } from "./eventBus.js";

export interface EngineLogSink {
  onStdout(chunk: string): void;
  onStderr(chunk: string): void;
  close(): void;
}

export const ENGINE_LOG_MAX_BYTES = 2 * 1024 * 1024;

const NOOP_SINK: EngineLogSink = { onStdout() {}, onStderr() {}, close() {} };

interface StreamState {
  file: string;
  buf: string;       // 未凑满一行的尾巴
  bytes: number;     // 首写时 stat 到的现有大小 + 本 sink 累计写入
  inited: boolean;   // 已 mkdir + stat
  truncated: boolean;// 已写截断标记,之后全丢
  disabled: boolean; // 首次写失败后静默禁用(best-effort)
}

export function createEngineLogSink(
  projectRoot: string,
  runId: string,
  engineLabel: string,
  agentId?: string,
): EngineLogSink {
  // 活体验证抓到的坑(2026-07-07):HTTP 团队/公司路径上,引擎拿到的 ctx.projectRoot 其实是
  // 工作区根(activeWorkRoot,如 .opc-studio/<公司>),不是项目根——直接用它会把日志写进公司
  // 文件夹的 .opc 里、与其它 run 证据分家。优先用 eventBus 的 canonical persistRoot(events.jsonl
  // 同根);未设置时(CLI/单测)退回调用方传入的 projectRoot。
  const root = getEventPersistRoot() || projectRoot;
  if (!runId || !root) return NOOP_SINK;
  const logsDir = path.join(root, ".opc", "runs", runId, "logs");
  const label = agentId ? `${engineLabel} ${agentId}` : engineLabel;

  const mkState = (filename: string): StreamState => ({
    file: path.join(logsDir, filename),
    buf: "",
    bytes: 0,
    inited: false,
    truncated: false,
    disabled: false,
  });
  const out = mkState("backend.stdout.log");
  const err = mkState("backend.stderr.log");

  const writeLines = (s: StreamState, lines: string[]): void => {
    if (s.disabled || s.truncated || lines.length === 0) return;
    try {
      if (!s.inited) {
        fs.mkdirSync(logsDir, { recursive: true });
        try { s.bytes = fs.statSync(s.file).size; } catch { s.bytes = 0; }
        s.inited = true;
      }
      let pending = "";
      for (const line of lines) {
        const ts = new Date().toISOString();
        const rendered = `[${label} ${ts}] ${redactSecrets(line)}\n`;
        if (s.bytes + Buffer.byteLength(pending, "utf-8") + Buffer.byteLength(rendered, "utf-8") > ENGINE_LOG_MAX_BYTES) {
          pending += `[${label} ${ts}] [truncated: 单文件超过 ${ENGINE_LOG_MAX_BYTES} 字节上限,后续输出已丢弃]\n`;
          s.truncated = true;
          break;
        }
        pending += rendered;
      }
      if (pending) {
        fs.appendFileSync(s.file, pending, "utf-8");
        s.bytes += Buffer.byteLength(pending, "utf-8");
      }
    } catch {
      s.disabled = true; // best-effort:写失败绝不影响引擎执行,本流之后不再尝试
    }
  };

  const onChunk = (s: StreamState, chunk: string): void => {
    if (s.disabled || s.truncated || !chunk) return;
    try {
      s.buf += chunk;
      const idx = s.buf.lastIndexOf("\n");
      if (idx < 0) return;
      const complete = s.buf.slice(0, idx);
      s.buf = s.buf.slice(idx + 1);
      writeLines(s, complete.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)));
    } catch { s.disabled = true; }
  };

  const flush = (s: StreamState): void => {
    if (s.buf) {
      const tail = s.buf.endsWith("\r") ? s.buf.slice(0, -1) : s.buf;
      s.buf = "";
      writeLines(s, [tail]);
    }
  };

  return {
    onStdout(chunk: string) { onChunk(out, chunk); },
    onStderr(chunk: string) { onChunk(err, chunk); },
    close() { try { flush(out); flush(err); } catch { /* best-effort */ } },
  };
}
