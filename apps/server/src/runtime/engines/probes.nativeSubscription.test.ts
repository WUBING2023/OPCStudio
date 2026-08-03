import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __setNativeSubscriptionProbeDepsForTest,
  probeGeminiCliAsync,
  probeGrokBuildAsync,
  probeKimiCliAsync,
  probeNativeSubscriptionAsync,
  probeNativeSubscriptionPassiveAsync,
} from "./probes.js";

afterEach(() => {
  __setNativeSubscriptionProbeDepsForTest(null);
});

describe("native subscription availability probes", () => {
  it("does not start Gemini ACP or login when credentials are absent", async () => {
    let handshakes = 0;
    __setNativeSubscriptionProbeDepsForTest({
      version: async () => ({ ok: true, out: "1.2.3" }),
      acp: async () => { handshakes++; return null; },
    });

    const missingHome = fs.mkdtempSync(path.join(os.tmpdir(), "opc-gemini-missing-"));
    try {
      const result = await probeGeminiCliAsync(missingHome);
      expect(result).toMatchObject({
        framework: "gemini-cli",
        installed: true,
        loggedIn: false,
        version: "1.2.3",
      });
      expect(result.detail).toMatch(/explicit login button/);
      expect(handshakes).toBe(0);
    } finally {
      fs.rmSync(missingHome, { recursive: true, force: true });
    }
  });

  it("reports not installed without attempting an ACP handshake", async () => {
    let handshakes = 0;
    __setNativeSubscriptionProbeDepsForTest({
      version: async () => ({ ok: false, out: "missing" }),
      acp: async () => { handshakes++; return []; },
    });

    const result = await probeKimiCliAsync();
    expect(result).toMatchObject({ framework: "kimi-cli", installed: false, loggedIn: false });
    expect(handshakes).toBe(0);
  });

  it("passive status never starts an ACP handshake", async () => {
    let handshakes = 0;
    __setNativeSubscriptionProbeDepsForTest({
      version: async () => ({ ok: true, out: "0.50.0" }),
      acp: async () => { handshakes++; return []; },
    });

    const result = await probeNativeSubscriptionPassiveAsync("gemini-cli", "./missing-gemini-home");
    expect(result).toMatchObject({ framework: "gemini-cli", installed: true, loggedIn: false });
    expect(result.detail).toMatch(/never launch login/);
    expect(handshakes).toBe(0);
  });

  it.each([
    ["gemini-cli", "GEMINI_CLI_HOME", probeGeminiCliAsync],
    ["kimi-cli", "KIMI_CODE_HOME", probeKimiCliAsync],
    ["grok-build", "GROK_HOME", probeGrokBuildAsync],
  ] as const)("%s becomes logged in only after a successful ACP handshake", async (framework, envVar, probe) => {
    let seenEngine = "";
    let seenHome = "";
    __setNativeSubscriptionProbeDepsForTest({
      version: async () => ({ ok: true, out: "9.9.9\nextra" }),
      acp: async (engine, opts) => {
        seenEngine = engine;
        seenHome = opts?.env?.[envVar] || "";
        return [];
      },
    });

    const accountHome = fs.mkdtempSync(path.join(os.tmpdir(), `opc-${framework}-`));
    if (framework === "gemini-cli") {
      fs.mkdirSync(path.join(accountHome, ".gemini"), { recursive: true });
      fs.writeFileSync(path.join(accountHome, ".gemini", "oauth_creds.json"), "{}", "utf8");
    }
    try {
      const result = await probe(accountHome);
      expect(result).toMatchObject({ framework, installed: true, loggedIn: true, version: "9.9.9" });
      expect(seenEngine).toBe(framework);
      expect(path.resolve(seenHome)).toBe(path.resolve(accountHome));
    } finally {
      fs.rmSync(accountHome, { recursive: true, force: true });
    }
  });

  it("exports the unified probe used by NativeAcpSubscriptionEngine", async () => {
    __setNativeSubscriptionProbeDepsForTest({
      version: async (command) => ({ ok: command === "grok", out: "grok 1" }),
      acp: async () => [],
    });
    const result = await probeNativeSubscriptionAsync("grok-build");
    expect(result).toMatchObject({ framework: "grok-build", installed: true, loggedIn: true });
  });
});