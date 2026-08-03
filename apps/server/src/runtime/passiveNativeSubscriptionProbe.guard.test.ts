import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const READ_ONLY_CALLERS = [
  new URL("../routes/onboardingRoutes.ts", import.meta.url),
  new URL("./capabilityReport.ts", import.meta.url),
  new URL("./globalDoctor.ts", import.meta.url),
  new URL("./adaptiveModelBinding.ts", import.meta.url),
  new URL("./systemModel.ts", import.meta.url),
  new URL("../routes/setupRoutes.ts", import.meta.url),
];

const INTERACTIVE_PROBE = /probe(?:GeminiCli|KimiCli|GrokBuild)Async/;

describe("native subscription passive-probe boundary", () => {
  it.each(READ_ONLY_CALLERS)("never starts an ACP/login-capable probe from %s", (url) => {
    const source = fs.readFileSync(fileURLToPath(url), "utf8");
    expect(source).not.toMatch(INTERACTIVE_PROBE);
    expect(source).toContain("probeNativeSubscriptionPassiveAsync");
  });
});