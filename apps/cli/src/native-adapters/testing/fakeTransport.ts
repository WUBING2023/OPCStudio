import {
  NATIVE_ADAPTER_CONTRACT_VERSION,
  type NativeAdapterProfile,
  type NativeCapabilityFlags,
  type NativeTransport,
  type NativeTransportHello,
} from "../types.js";

export interface FakeTransportOptions {
  hostVersion?: string;
  protocolVersion?: string;
  schemaVersion?: string;
  capabilities?: Partial<NativeCapabilityFlags>;
}

export class FakeNativeTransport implements NativeTransport {
  readonly kind = "fake";
  readonly calls: Array<{ method: string; params: unknown }> = [];
  private readonly failures = new Map<string, unknown>();
  private readonly responses = new Map<string, unknown>();
  private readonly listeners = new Set<(message: Record<string, unknown>) => void>();

  constructor(private readonly options: FakeTransportOptions = {}) {}

  reject(method: string, error: unknown): void {
    this.failures.set(method, error);
  }

  respondWith(method: string, response: unknown): void {
    this.responses.set(method, response);
  }

  onMessage(listener: (message: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(message: Record<string, unknown>): void {
    for (const listener of this.listeners) listener(message);
  }

  async initialize(_profile: NativeAdapterProfile): Promise<NativeTransportHello> {
    return {
      schemaVersion: (this.options.schemaVersion ?? NATIVE_ADAPTER_CONTRACT_VERSION) as NativeTransportHello["schemaVersion"],
      hostVersion: this.options.hostVersion ?? "0.145.0",
      protocolVersion: this.options.protocolVersion ?? "jsonl-v1",
      capabilities: this.options.capabilities,
    };
  }

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (this.failures.has(method)) throw this.failures.get(method);
    return (this.responses.get(method) ?? {}) as T;
  }

  async respond(requestId: string | number, result: unknown): Promise<void> {
    this.calls.push({ method: "respond", params: { requestId, result } });
    if (this.failures.has("respond")) throw this.failures.get("respond");
  }

  async interrupt(sessionId: string, turnId?: string): Promise<void> {
    this.calls.push({ method: "interrupt", params: { sessionId, turnId } });
    if (this.failures.has("interrupt")) throw this.failures.get("interrupt");
  }
}
