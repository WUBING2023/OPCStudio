import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderKey, collectApiKeys, syncProvidersFromStore, isProviderAvailable, canonicalProviderId, collectConfiguredProviderCapabilities, providerNetworkOptions } from "./providerRegistry.js";

// Block C · provider key 解析优先级:env <PROVIDER>_API_KEY > keys/<provider>.key > config.apiKeys。
// 这样把明文 key 移出 config 后,各路径仍能从 env / keys 目录拿到。

function tmpProject(configKeys?: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pk-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  if (configKeys) fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({ apiKeys: configKeys }));
  return root;
}
function tmpKeysDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keys-"));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

describe("Block C · resolveProviderKey 优先级", () => {
  const savedEnv = process.env.DEEPSEEK_API_KEY;
  const savedDir = process.env.OPC_KEYS_DIR;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = savedEnv;
    if (savedDir === undefined) delete process.env.OPC_KEYS_DIR; else process.env.OPC_KEYS_DIR = savedDir;
  });

  it("仅 config → 取 config", () => {
    delete process.env.DEEPSEEK_API_KEY; delete process.env.OPC_KEYS_DIR;
    expect(resolveProviderKey(tmpProject({ deepseek: "cfg-key" }), "deepseek")).toBe("cfg-key");
  });
  it("keys/<provider>.key 覆盖 config", () => {
    delete process.env.DEEPSEEK_API_KEY;
    process.env.OPC_KEYS_DIR = tmpKeysDir({ "deepseek.key": "file-key\n" });
    expect(resolveProviderKey(tmpProject({ deepseek: "cfg-key" }), "deepseek")).toBe("file-key");
  });
  it("env <PROVIDER>_API_KEY 最高优先", () => {
    process.env.OPC_KEYS_DIR = tmpKeysDir({ "deepseek.key": "file-key" });
    process.env.DEEPSEEK_API_KEY = "env-key";
    expect(resolveProviderKey(tmpProject({ deepseek: "cfg-key" }), "deepseek")).toBe("env-key");
  });
  it("config 无该 key 也无 keys/env → undefined(明文已移除仍不崩)", () => {
    delete process.env.DEEPSEEK_API_KEY; delete process.env.OPC_KEYS_DIR;
    expect(resolveProviderKey(tmpProject({}), "deepseek")).toBeUndefined();
  });
  it("collectApiKeys:keys 文件覆盖 config,无文件的 provider 回退 config", () => {
    delete process.env.DEEPSEEK_API_KEY;
    process.env.OPC_KEYS_DIR = tmpKeysDir({ "minimax.key": "mm-file" });
    const merged = collectApiKeys(tmpProject(), { deepseek: "ds-cfg", minimax: "mm-cfg" });
    expect(merged.deepseek).toBe("ds-cfg");
    expect(merged.minimax).toBe("mm-file");
  });
});

// Block D · syncProvidersFromStore 回填 accounts.json:CLI API Key 账号体系(accounts.json)与
// config.apiKeys/providers.json 是两套平行的凭据存储,只在账号 UI 里配的 key 此前永远无法喂到
// callModel 的 registry(Mission Brief/意图分类/Harness 验收官/Loop 复盘等系统级调用因此报
// "no handler registered"),即便 team/worker 执行链路(accountPool)已经能正常租到它。
describe("Block D · syncProvidersFromStore 回填 accounts.json", () => {
  it("accounts.json 里持有 apiKey 的账号(config/providers.json 都未配置同名 provider)会被登记进 registry", () => {
    const root = tmpProject();
    fs.writeFileSync(path.join(root, ".opc", "accounts.json"), JSON.stringify([
      { id: "acct-test-xyz#0", providerId: "acct-test-xyz", label: "test", apiKey: "test-account-key", baseUrl: "https://acct-test.example.com/v1", enabled: true, maxConcurrent: 1 },
    ]));
    expect(isProviderAvailable("acct-test-xyz")).toBe(false);
    const registered = syncProvidersFromStore(root);
    expect(registered).toContain("acct-test-xyz");
    expect(isProviderAvailable("acct-test-xyz")).toBe(true);
  });

  it("providers.json 已显式登记的 provider 不会被同名 accounts.json 账号覆盖(只登记一次)", () => {
    const root = tmpProject();
    fs.writeFileSync(path.join(root, ".opc", "providers.json"), JSON.stringify([
      { id: "acct-test-abc", name: "abc", apiFormat: "openai", baseUrl: "https://provider.example.com/v1", apiKey: "provider-key" },
    ]));
    fs.writeFileSync(path.join(root, ".opc", "accounts.json"), JSON.stringify([
      { id: "acct-test-abc#0", providerId: "acct-test-abc", label: "test", apiKey: "account-key", enabled: true, maxConcurrent: 1 },
    ]));
    const registered = syncProvidersFromStore(root);
    expect(registered.filter((name) => name === "acct-test-abc")).toHaveLength(1);
  });

  it("account 没有 apiKey(纯订阅态 CLI 账号)或无法解析 baseUrl 时不登记", () => {
    const root = tmpProject();
    fs.writeFileSync(path.join(root, ".opc", "accounts.json"), JSON.stringify([
      { id: "acct-test-nosub#0", providerId: "acct-test-nosub", label: "no key", apiKey: "", enabled: true, maxConcurrent: 3, frameworks: ["claude-code"] },
      { id: "acct-test-nourl#0", providerId: "acct-test-nourl", label: "no baseUrl", apiKey: "some-key", enabled: true, maxConcurrent: 1 },
    ]));
    const registered = syncProvidersFromStore(root);
    expect(registered).not.toContain("acct-test-nosub");
    expect(registered).not.toContain("acct-test-nourl");
  });
});

describe("canonical provider aliases and capability snapshot", () => {
  it("recognizes a legacy random-id DeepSeek preset by its canonical base URL", () => {
    const root = tmpProject();
    fs.writeFileSync(path.join(root, ".opc", "providers.json"), JSON.stringify([{
      id: "legacy-random-id",
      name: "DeepSeek",
      kind: "unified",
      apiFormat: "openai",
      baseUrl: "https://api.deepseek.com/v1/",
      apiKey: "stored-provider-key",
      defaultModel: "deepseek-chat",
      models: ["deepseek-chat"],
    }]));
    const stored = JSON.parse(fs.readFileSync(path.join(root, ".opc", "providers.json"), "utf8"))[0];
    expect(canonicalProviderId(stored)).toBe("deepseek");
    expect(resolveProviderKey(root, "deepseek")).toBe("stored-provider-key");
    const registered = syncProvidersFromStore(root);
    expect(registered).toEqual(expect.arrayContaining(["legacy-random-id", "deepseek"]));
  });

  it("includes providers.json credentials and their real default model in template replacement candidates", () => {
    const root = tmpProject();
    fs.writeFileSync(path.join(root, ".opc", "providers.json"), JSON.stringify([{
      id: "local-compatible",
      name: "Local Compatible",
      kind: "custom",
      apiFormat: "openai",
      baseUrl: "https://local-compatible.example.com/v1",
      apiKey: "stored-provider-key",
      defaultModel: "local-model-v2",
      models: ["local-model-v2"],
    }]));
    const snapshot = collectConfiguredProviderCapabilities(root);
    expect(snapshot.availableProviders.has("local-compatible")).toBe(true);
    expect(snapshot.defaultModels.get("local-compatible")).toBe("local-model-v2");
  });
});
describe("provider network policy", () => {
  it("allows only the synthetic proxy range for an exact official HTTPS preset", () => {
    expect(providerNetworkOptions("deepseek", "https://api.deepseek.com/v1")).toEqual({
      allowSyntheticProxyAddress: true,
    });
  });

  it("does not trust a canonical-looking id when its endpoint was changed", () => {
    expect(canonicalProviderId({ id: "deepseek", baseUrl: "http://127.0.0.1:8080/v1" })).toBeUndefined();
    expect(providerNetworkOptions("deepseek", "http://127.0.0.1:8080/v1")).toEqual({});
  });

  it("keeps explicitly authorized local providers available", () => {
    expect(providerNetworkOptions("custom-local", "http://127.0.0.1:11434/v1", true, "local")).toEqual({
      allowLocalNetwork: true,
    });
  });
});
