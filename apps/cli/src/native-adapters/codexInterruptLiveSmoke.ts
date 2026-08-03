import { CODEX_NATIVE_PROFILE } from "./profiles.js";
import { CodexAppServerTransport, readInstalledCodexVersion } from "./codexAppServer.js";
import { createNativeAdapter, negotiateNativeCapabilities } from "./nativeAdapter.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

async function main(): Promise<void> {
  const cwd = process.argv[2] ?? process.cwd();
  const hostVersion = await readInstalledCodexVersion();
  const transport = CodexAppServerTransport.start({
    hostVersion,
    cwd,
    requestTimeoutMs: 60_000,
  });
  const methods: string[] = [];
  let resolveStarted!: (turnId: string) => void;
  const started = new Promise<string>((resolve) => { resolveStarted = resolve; });
  let resolveTerminal!: (status: string) => void;
  const terminal = new Promise<string>((resolve) => { resolveTerminal = resolve; });
  const unsubscribe = transport.onMessage((message) => {
    const method = typeof message.method === "string" ? message.method : "";
    if (method) methods.push(method);
    if (method === "turn/started") {
      const params = asRecord(message.params);
      const turn = asRecord(params.turn);
      const id = String(turn.id ?? "");
      if (id) resolveStarted(id);
    }
    if (method === "turn/completed") {
      const params = asRecord(message.params);
      const turn = asRecord(params.turn);
      resolveTerminal(String(turn.status ?? params.status ?? "unknown"));
    }
  });

  try {
    const negotiation = await negotiateNativeCapabilities(CODEX_NATIVE_PROFILE, transport);
    if (!negotiation.compatible || !negotiation.capabilities.start || !negotiation.capabilities.interrupt) {
      throw new Error("Codex native start/interrupt capability negotiation failed");
    }
    const adapter = createNativeAdapter(CODEX_NATIVE_PROFILE, transport);
    const execution = await adapter.start({
      runId: "codex-native-interrupt-live",
      cwd,
      prompt: "Before replying, carefully calculate the first 10000 prime numbers without using tools.",
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const sessionId = execution.session.externalSessionId;
    const turnId = execution.session.externalTurnId;
    if (!sessionId || !turnId) throw new Error("Codex turn/start did not return thread and turn ids");
    const startedTurnId = await Promise.race([
      started,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("turn/started notification timed out")), 10_000)),
    ]);
    if (startedTurnId !== turnId) throw new Error("turn/started id does not match turn/start response");
    await adapter.interrupt({
      externalSessionId: sessionId,
      externalTurnId: turnId,
    });
    const terminalStatus = await Promise.race([
      terminal,
      new Promise<string>((resolve) => setTimeout(() => resolve("interrupt_acknowledged"), 10_000)),
    ]);
    const interrupted = terminalStatus === "interrupted" || terminalStatus === "interrupt_acknowledged";
    process.stdout.write(JSON.stringify({
      ok: interrupted,
      hostVersion,
      threadId: sessionId,
      turnId,
      terminalStatus,
      interruptRequested: true,
      lifecycleMethods: Array.from(new Set(methods.filter((method) =>
        ["thread/started", "turn/started", "turn/completed", "thread/status/changed"].includes(method),
      ))),
    }) + "\n");
    if (!interrupted) process.exitCode = 1;
  } finally {
    unsubscribe();
    await transport.close();
  }
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }) + "\n");
  process.exitCode = 1;
});
