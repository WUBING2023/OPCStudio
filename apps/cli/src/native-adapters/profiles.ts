import { NATIVE_ADAPTER_CONTRACT_VERSION, type NativeAdapterProfile } from "./types.js";

const supported = (evidence: string) => ({ state: "supported" as const, evidence });
const unsupported = (evidence: string) => ({ state: "unsupported" as const, evidence });

export const CODEX_NATIVE_PROFILE: NativeAdapterProfile = {
  schemaVersion: NATIVE_ADAPTER_CONTRACT_VERSION,
  adapterId: "opc.codex-app-server",
  adapterVersion: "0.1.0",
  host: "codex",
  protocol: "codex-app-server-jsonrpc",
  compatibleHostVersions: ">=0.100.0 <1.0.0",
  capabilities: {
    start: supported("Official app-server thread/start and turn/start JSON-RPC methods"),
    resume: supported("Official app-server thread/resume method"),
    fork: supported("Official app-server thread/fork method"),
    interrupt: supported("Official app-server turn/interrupt method"),
    approval: supported("Official server-initiated approval request/response flow"),
    events: supported("Official JSONL turn/item notification stream"),
  },
  methods: {
    start: "thread/start",
    resume: "thread/resume",
    fork: "thread/fork",
    interrupt: "turn/interrupt",
  },
};

export const CLAUDE_NATIVE_PROFILE: NativeAdapterProfile = {
  schemaVersion: NATIVE_ADAPTER_CONTRACT_VERSION,
  adapterId: "opc.claude-agent-sdk",
  adapterVersion: "0.1.0",
  host: "claude-code",
  protocol: "claude-agent-sdk",
  compatibleHostVersions: ">=0.3.0 <1.0.0",
  capabilities: {
    start: supported("Official @anthropic-ai/claude-agent-sdk query() async stream"),
    resume: supported("Official query() options.resume session continuation"),
    fork: supported("Official query() options.resume + forkSession"),
    interrupt: unsupported("Query.interrupt() requires the original live Query object; detached session ids cannot address it"),
    approval: supported("Official canUseTool permission callback"),
    events: supported("Official SDKMessage async stream"),
  },
  methods: {
    start: "query",
    resume: "query.resume",
    fork: "query.fork",
  },
};
