import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const WORKSPACE_RUNTIME_REFERENCE = /(?:from\s+|import\s*(?:\(|)|require\s*\()\s*["'](?:@opc\/(?:shared|server)|[^"']*(?:packages[\\/]shared[\\/]src|apps[\\/]server[\\/]src))/i;
const RELATIVE_IMPORT = /(?:from\s+|import\s*)["'](\.{1,2}\/[^"']+)["']/g;

export interface StandaloneMcpManifest {
  schemaVersion: "1";
  entrypoint: "mcp/index.js";
  sharedContract: string;
  sharedContractSha256: string;
}

export interface PackageStandaloneMcpOptions {
  distRoot: string;
  sharedContractSource: string;
}

export function rewriteSharedContractImport(source: string, replacement: string): string {
  return source.replace(/(["'])@opc\/shared\1/g, (_match, quote: string) => `${quote}${replacement}${quote}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compileSharedContractGraph(entrypoint: string, outputDirectory: string): string {
  const sourceRoot = path.dirname(entrypoint);
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    rootDir: sourceRoot,
    outDir: outputDirectory,
    sourceMap: false,
    declaration: false,
    skipLibCheck: true,
    noEmitOnError: true,
  };
  const program = ts.createProgram([entrypoint], compilerOptions);
  const result = program.emit();
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(result.diagnostics);
  const errors = diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    const message = errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("; ");
    throw new Error(`Unable to compile the shared MCP contract graph: ${message}`);
  }
  const relativeEntry = path.relative(sourceRoot, entrypoint).replace(/\.tsx?$/i, ".js");
  return path.join(outputDirectory, relativeEntry);
}

function hashEmittedGraph(directory: string): string {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(full);
    }
  };
  visit(directory);
  const payload = files.sort().map((file) => (
    `${path.relative(directory, file).split(path.sep).join("/")}\0${fs.readFileSync(file, "utf8")}`
  )).join("\0");
  return sha256(payload);
}

function emittedDependencies(filePath: string, source: string): string[] {
  const dependencies: string[] = [];
  for (const match of source.matchAll(RELATIVE_IMPORT)) {
    const candidate = path.resolve(path.dirname(filePath), match[1]);
    dependencies.push(path.extname(candidate) ? candidate : `${candidate}.js`);
  }
  return dependencies;
}

export function assertStandaloneMcpGraph(distRoot: string): void {
  const entrypoint = path.join(distRoot, "mcp", "index.js");
  const pending = [entrypoint];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const filePath = pending.pop()!;
    if (visited.has(filePath)) continue;
    visited.add(filePath);
    if (!fs.existsSync(filePath)) throw new Error(`Standalone MCP dependency is missing: ${path.relative(distRoot, filePath)}`);
    const source = fs.readFileSync(filePath, "utf8");
    if (WORKSPACE_RUNTIME_REFERENCE.test(source)) {
      throw new Error(`Standalone MCP contains a workspace runtime reference: ${path.relative(distRoot, filePath)}`);
    }
    for (const dependency of emittedDependencies(filePath, source)) {
      if (dependency.startsWith(`${distRoot}${path.sep}`)) pending.push(dependency);
    }
  }
}

export function packageStandaloneMcp(options: PackageStandaloneMcpOptions): StandaloneMcpManifest {
  const toolsPath = path.join(options.distRoot, "mcp", "tools.js");
  if (!fs.existsSync(toolsPath)) throw new Error(`MCP tools output is missing: ${toolsPath}`);
  const vendorDirectory = path.join(options.distRoot, "vendor", "shared");
  fs.rmSync(vendorDirectory, { recursive: true, force: true });
  fs.mkdirSync(vendorDirectory, { recursive: true });
  const emittedContract = compileSharedContractGraph(options.sharedContractSource, vendorDirectory);

  const toolsSource = fs.readFileSync(toolsPath, "utf8");
  const relativeContract = path.relative(path.dirname(toolsPath), emittedContract)
    .split(path.sep).join("/");
  const importSpecifier = relativeContract.startsWith(".") ? relativeContract : `./${relativeContract}`;
  const rewrittenTools = rewriteSharedContractImport(toolsSource, importSpecifier);
  if (rewrittenTools.includes("@opc/shared")) {
    throw new Error("Unable to remove @opc/shared from the published MCP dependency graph");
  }
  fs.writeFileSync(toolsPath, rewrittenTools, "utf8");

  const manifest: StandaloneMcpManifest = {
    schemaVersion: "1",
    entrypoint: "mcp/index.js",
    sharedContract: path.relative(options.distRoot, emittedContract).split(path.sep).join("/"),
    sharedContractSha256: hashEmittedGraph(vendorDirectory),
  };
  fs.writeFileSync(path.join(options.distRoot, "mcp-runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  assertStandaloneMcpGraph(options.distRoot);
  return manifest;
}

function runFromBuildOutput(): void {
  const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const repositoryRoot = path.resolve(cliRoot, "..", "..");
  packageStandaloneMcp({
    distRoot: path.join(cliRoot, "dist"),
    sharedContractSource: path.join(repositoryRoot, "packages", "shared", "src", "mcpContract.ts"),
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) runFromBuildOutput();
