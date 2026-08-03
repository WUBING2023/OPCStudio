export type FeatureFlagReleaseStage = "experimental" | "preview" | "ga";
export type FeatureFlagDeadlineVersion = `${number}.${number}.${number}` | "permanent";

export interface FeatureFlagDefinition {
  owner: string;
  default: boolean;
  minVersion: `${number}.${number}.${number}`;
  releaseStage: FeatureFlagReleaseStage;
  removalCondition: string;
  deadlineVersion: FeatureFlagDeadlineVersion;
}

export const FEATURE_FLAG_NAMES = [
  "OPC_NEW_NAVIGATION",
  "OPC_HEADLESS_CLI_V2",
  "OPC_CANONICAL_EVENTS_V1",
  "OPC_MCP_SERVER",
  "OPC_CODEX_PLUGIN",
  "OPC_CLAUDE_PLUGIN",
  "OPC_CODEX_NATIVE_ADAPTER",
  "OPC_CLAUDE_NATIVE_ADAPTER",
  "OPC_EMBEDDED_PLUGIN_UI",
  "OPC_PLUGIN_DISCOVERY",
] as const;

export type FeatureFlagName = typeof FEATURE_FLAG_NAMES[number];

export const FEATURE_FLAG_REGISTRY = {
  OPC_NEW_NAVIGATION: {
    owner: "web-platform",
    default: false,
    minVersion: "0.1.0",
    releaseStage: "preview",
    removalCondition: "Remove after the converged navigation passes the Phase 1 browser matrix and becomes the only supported route model.",
    deadlineVersion: "0.4.0",
  },
  OPC_HEADLESS_CLI_V2: {
    owner: "cli-platform",
    default: false,
    minVersion: "0.1.0",
    releaseStage: "ga",
    removalCondition: "Permanent GA compatibility gate; retire only with a major headless CLI contract replacement.",
    deadlineVersion: "permanent",
  },
  OPC_CANONICAL_EVENTS_V1: {
    owner: "runtime-contracts",
    default: false,
    minVersion: "0.1.0",
    releaseStage: "ga",
    removalCondition: "Permanent GA compatibility gate; retire only when a versioned canonical event contract supersedes v1.",
    deadlineVersion: "permanent",
  },
  OPC_MCP_SERVER: {
    owner: "ecosystem-platform",
    default: false,
    minVersion: "0.1.0",
    releaseStage: "preview",
    removalCondition: "Remove after the MCP release gate and setup-unavailable behavior pass on every supported distribution.",
    deadlineVersion: "0.4.0",
  },
  OPC_CODEX_PLUGIN: {
    owner: "ecosystem-platform",
    default: false,
    minVersion: "0.1.0",
    releaseStage: "preview",
    removalCondition: "Remove after the Codex plugin manifest, discovery, lifecycle, and uninstall gates are GA.",
    deadlineVersion: "0.4.0",
  },
  OPC_CLAUDE_PLUGIN: {
    owner: "ecosystem-platform",
    default: false,
    minVersion: "0.1.0",
    releaseStage: "preview",
    removalCondition: "Remove after the Claude plugin manifest, discovery, lifecycle, and uninstall gates are GA.",
    deadlineVersion: "0.4.0",
  },
  OPC_CODEX_NATIVE_ADAPTER: {
    owner: "runtime-integrations",
    default: false,
    minVersion: "0.1.0",
    releaseStage: "experimental",
    removalCondition: "Remove after the Codex native adapter passes parity, recovery, and rollback gates or is abandoned.",
    deadlineVersion: "0.5.0",
  },
  OPC_CLAUDE_NATIVE_ADAPTER: {
    owner: "runtime-integrations",
    default: false,
    minVersion: "0.1.0",
    releaseStage: "experimental",
    removalCondition: "Remove after the Claude native adapter passes parity, recovery, and rollback gates or is abandoned.",
    deadlineVersion: "0.5.0",
  },
  OPC_EMBEDDED_PLUGIN_UI: {
    owner: "web-platform",
    default: false,
    minVersion: "0.1.0",
    releaseStage: "experimental",
    removalCondition: "Remove after embedded read-only cards pass host compatibility and responsive layout gates.",
    deadlineVersion: "0.5.0",
  },
  OPC_PLUGIN_DISCOVERY: {
    owner: "ecosystem-platform",
    default: false,
    minVersion: "0.1.0",
    releaseStage: "experimental",
    removalCondition: "Remove after plugin discovery is available and rollback-safe on all supported hosts.",
    deadlineVersion: "0.5.0",
  },
} as const satisfies Readonly<Record<FeatureFlagName, FeatureFlagDefinition>>;

export type FeatureFlagValues = Record<FeatureFlagName, boolean>;

export interface FeatureFlagResolutionInput {
  currentVersion?: string;
  environment?: Readonly<Record<string, unknown>>;
  persisted?: unknown;
}

const FLAG_NAMES: readonly FeatureFlagName[] = FEATURE_FLAG_NAMES;
const RELEASE_STAGES = new Set<FeatureFlagReleaseStage>(["experimental", "preview", "ga"]);

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "on", "yes", "enabled"].includes(normalized)) return true;
  if (["0", "false", "off", "no", "disabled"].includes(normalized)) return false;
  return undefined;
}

function parseVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(left: [number, number, number], right: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateFeatureFlagRegistry(registry: unknown): string[] {
  const errors: string[] = [];
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) return ["registry must be an object"];

  const record = registry as Record<string, unknown>;
  for (const name of FEATURE_FLAG_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(record, name)) errors.push(`${name}: required flag missing`);
  }

  for (const [name, rawDefinition] of Object.entries(record)) {
    if (!(FEATURE_FLAG_NAMES as readonly string[]).includes(name)) errors.push(`${name}: unknown flag`);
    if (!/^OPC_[A-Z0-9_]+$/.test(name)) errors.push(`${name}: invalid flag name`);
    if (!rawDefinition || typeof rawDefinition !== "object" || Array.isArray(rawDefinition)) {
      errors.push(`${name}: definition must be an object`);
      continue;
    }
    const definition = rawDefinition as Record<string, unknown>;
    if (!isNonEmptyString(definition.owner)) errors.push(`${name}: owner is required`);
    if (typeof definition.default !== "boolean") errors.push(`${name}: default must be boolean`);
    if (definition.default !== false) errors.push(`${name}: default must be fail-closed`);
    if (!RELEASE_STAGES.has(definition.releaseStage as FeatureFlagReleaseStage)) errors.push(`${name}: invalid releaseStage`);
    if (!isNonEmptyString(definition.removalCondition)) errors.push(`${name}: removalCondition is required`);

    const minimum = parseVersion(definition.minVersion);
    if (!minimum) errors.push(`${name}: invalid minVersion`);
    const deadline = definition.deadlineVersion;
    if (deadline !== "permanent") {
      const parsedDeadline = parseVersion(deadline);
      if (!parsedDeadline) errors.push(`${name}: invalid deadlineVersion`);
      else if (minimum && compareVersions(parsedDeadline, minimum) <= 0) errors.push(`${name}: deadlineVersion must be greater than minVersion`);
      if (definition.releaseStage === "ga") errors.push(`${name}: GA flags must use a permanent deadline`);
    }
  }
  return errors;
}

export const FEATURE_FLAG_REGISTRY_ERRORS = Object.freeze(validateFeatureFlagRegistry(FEATURE_FLAG_REGISTRY));

function versionAllows(current: string | undefined, definition: FeatureFlagDefinition): boolean {
  const parsedCurrent = parseVersion(current);
  const minimum = parseVersion(definition.minVersion);
  if (!parsedCurrent || !minimum || compareVersions(parsedCurrent, minimum) < 0) return false;
  if (definition.deadlineVersion === "permanent") return true;
  const deadline = parseVersion(definition.deadlineVersion);
  return Boolean(deadline && compareVersions(parsedCurrent, deadline) < 0);
}

function persistedRecord(value: unknown): Readonly<Record<string, unknown>> {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return {}; }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, "flags")) return record;
  const nested = record.flags;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : {};
}

function overrideValue(
  name: FeatureFlagName,
  environment: Readonly<Record<string, unknown>>,
  persisted: Readonly<Record<string, unknown>>,
): boolean | undefined {
  const envKeys = [name, `VITE_${name}`];
  for (const key of envKeys) {
    if (!Object.prototype.hasOwnProperty.call(environment, key)) continue;
    return parseBoolean(environment[key]) ?? false;
  }
  if (Object.prototype.hasOwnProperty.call(persisted, name)) {
    return parseBoolean(persisted[name]) ?? false;
  }
  return undefined;
}

export function resolveFeatureFlags(input: FeatureFlagResolutionInput = {}): FeatureFlagValues {
  if (FEATURE_FLAG_REGISTRY_ERRORS.length > 0) {
    return Object.fromEntries(FLAG_NAMES.map((name) => [name, false])) as FeatureFlagValues;
  }
  const environment = input.environment ?? {};
  const persisted = persistedRecord(input.persisted);
  return Object.fromEntries(FLAG_NAMES.map((name) => {
    const definition = FEATURE_FLAG_REGISTRY[name] as FeatureFlagDefinition;
    if (!versionAllows(input.currentVersion, definition)) return [name, false];
    return [name, overrideValue(name, environment, persisted) ?? definition.default];
  })) as FeatureFlagValues;
}

export function resolveFeatureFlag(name: string, input: FeatureFlagResolutionInput = {}): boolean {
  if (!Object.prototype.hasOwnProperty.call(FEATURE_FLAG_REGISTRY, name)) return false;
  return resolveFeatureFlags(input)[name as FeatureFlagName];
}
