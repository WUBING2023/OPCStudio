import { describe, expect, it } from "vitest";
import * as fs from "node:fs";

const routeSource = fs.readFileSync(new URL("./skillRoutes.ts", import.meta.url), "utf8");
const installSource = routeSource.slice(routeSource.indexOf('app.post("/api/skills/:id/incubate/install"'));
const modalSource = fs.readFileSync(
  new URL("../../../web/src/components/skills/IncubatorModal.tsx", import.meta.url),
  "utf8",
);

describe("skill incubator adaptive execution binding contract", () => {
  it("generation and install both resolve a server-authoritative executable binding", () => {
    expect(routeSource).toContain("const binding = await resolveAdaptiveModelBinding(projectRoot)");
    expect(installSource).toContain("const resolvedBinding = await resolveAdaptiveModelBinding(projectRoot, requestedBinding)");
    expect(installSource).toContain("node.framework = executionBinding.framework");
    expect(installSource).toContain("framework: executionBinding.framework");
  });

  it("does not hard-code DeepSeek into newly installed workers or teams", () => {
    expect(installSource).not.toMatch(/model:s*["']deepseek/i);
    expect(installSource).not.toMatch(/provider:s*["']deepseek/i);
  });

  it("shows and returns the reviewed binding instead of a model-authored suggestion", () => {
    expect(modalSource).toContain("setBinding(r.binding)");
    expect(modalSource).toContain("provider} / {binding.model");
    expect(modalSource).toContain("design, parentId, binding");
    expect(modalSource).toContain("design, binding");
    expect(modalSource).not.toContain("suggestedModel");
  });
});
