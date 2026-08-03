import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { register } from "./skillRoutes.js";
import { getSkill } from "../storage/skillStore.js";

const tempRoots: string[] = [];
const originalSkillsDir = process.env.OPC_SKILLS_DIR;
const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  if (originalSkillsDir === undefined) delete process.env.OPC_SKILLS_DIR;
  else process.env.OPC_SKILLS_DIR = originalSkillsDir;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("local Skill routes", () => {
  it("discovers and imports a Codex SKILL.md through an opaque discovery id", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-local-skill-route-"));
    tempRoots.push(root);
    process.env.OPC_SKILLS_DIR = path.join(root, "opc-skills");
    process.env.CODEX_HOME = path.join(root, "codex");
    const sourceDir = path.join(process.env.CODEX_HOME, "skills", "focused-review");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "SKILL.md"), [
      "---",
      "name: Focused Review",
      "description: Review only changed behavior",
      "role: test",
      "---",
      "Inspect the changed files and run focused tests.",
    ].join("\n"), "utf8");

    const app = express();
    app.use(express.json());
    register(app, root);
    const server = app.listen(0);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind");
      const base = `http://127.0.0.1:${address.port}`;
      const discovered = await fetch(`${base}/api/skills/local`).then((res) => res.json()) as Array<{ id: string; name: string; installed: boolean }>;
      const target = discovered.find((item) => item.name === "Focused Review");
      expect(target).toMatchObject({ name: "Focused Review", installed: false });
      if (!target) throw new Error("expected local Skill was not discovered");

      const importedResponse = await fetch(`${base}/api/skills/local/${target.id}/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(importedResponse.status).toBe(201);
      expect(getSkill(root, "focused-review")).toMatchObject({
        title: "Focused Review",
        role: "test",
        origin: "user",
        content: "Inspect the changed files and run focused tests.",
      });

      const duplicateResponse = await fetch(`${base}/api/skills/local/${target.id}/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(duplicateResponse.status).toBe(200);
      expect(await duplicateResponse.json()).toMatchObject({ duplicate: true });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
