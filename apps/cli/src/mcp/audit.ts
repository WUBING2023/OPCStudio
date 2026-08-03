import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface McpAuditRecord {
  timestamp?: string;
  identity?: string;
  tool: "start_run" | "cancel_run" | "propose_memory" | "review_run" | "apply_company_plan";
  idempotencyKey: string;
  outcome: "intent" | "accepted" | "failed";
  companyId?: string;
  runId?: string;
  taskHash?: string;
  contentHash?: string;
  errorCode?: string;
}

export type McpAuditWriter = (record: McpAuditRecord) => Promise<void>;

export function createFileAuditWriter(options: {
  homeDir?: string;
  now?: () => string;
  identity?: string;
} = {}): McpAuditWriter {
  const auditDirectory = path.join(options.homeDir ?? os.homedir(), ".opc-studio");
  const auditFile = path.join(auditDirectory, "mcp-audit.jsonl");
  const now = options.now ?? (() => new Date().toISOString());
  const identity = options.identity ?? "local-session";

  return async (record) => {
    await fs.promises.mkdir(auditDirectory, { recursive: true, mode: 0o700 });
    const handle = await fs.promises.open(auditFile, "a", 0o600);
    try {
      await handle.appendFile(JSON.stringify({
        ...record,
        timestamp: record.timestamp ?? now(),
        identity: record.identity ?? identity,
      }) + "\n", "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.chmod(auditFile, 0o600).catch(() => undefined);
  };
}
