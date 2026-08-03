import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertStandaloneMcpGraph,
  packageStandaloneMcp,
  rewriteSharedContractImport,
} from "./packageStandaloneMcp.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opc-mcp-package-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("standalone MCP packaging", () => {
  it("rewrites only the shared contract package import", () => {
    const source = 'import { parseRunEvents } from "@opc/shared";\nimport { z } from "zod";\n';
    expect(rewriteSharedContractImport(source, "../vendor/shared/ecosystemContract.js")).toBe(
      'import { parseRunEvents } from "../vendor/shared/ecosystemContract.js";\nimport { z } from "zod";\n',
    );
  });

  it("vendors the compiled ecosystem contract and rejects workspace runtime references", () => {
    const root = temporaryDirectory();
    const distRoot = path.join(root, "dist");
    const sharedSource = path.join(root, "ecosystemContract.ts");
    fs.mkdirSync(path.join(distRoot, "mcp"), { recursive: true });
    fs.writeFileSync(path.join(distRoot, "mcp", "index.js"), 'import "./tools.js";\n');
    fs.writeFileSync(
      path.join(distRoot, "mcp", "tools.js"),
      'import { parseRunEvents } from "@opc/shared";\nexport { parseRunEvents };\n',
    );
    fs.writeFileSync(sharedSource, 'export const parseRunEvents = (values: unknown[]) => values;\n');

    const manifest = packageStandaloneMcp({ distRoot, sharedContractSource: sharedSource });

    const tools = fs.readFileSync(path.join(distRoot, "mcp", "tools.js"), "utf8");
    const contract = fs.readFileSync(path.join(distRoot, "vendor", "shared", "ecosystemContract.js"), "utf8");
    expect(tools).toContain('../vendor/shared/ecosystemContract.js');
    expect(contract).not.toContain(": unknown");
    expect(manifest.entrypoint).toBe("mcp/index.js");
    expect(manifest.sharedContract).toBe("vendor/shared/ecosystemContract.js");
    expect(manifest.sharedContractSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => assertStandaloneMcpGraph(distRoot)).not.toThrow();

    fs.appendFileSync(path.join(distRoot, "mcp", "tools.js"), "// packages/shared/src is documentation, not a runtime import\n");
    expect(() => assertStandaloneMcpGraph(distRoot)).not.toThrow();

    fs.writeFileSync(path.join(distRoot, "mcp", "bad.js"), 'import "@opc/shared";\n');
    fs.writeFileSync(path.join(distRoot, "mcp", "index.js"), 'import "./tools.js";\nimport "./bad.js";\n');
    expect(() => assertStandaloneMcpGraph(distRoot)).toThrow(/workspace runtime reference/i);
  });
});
