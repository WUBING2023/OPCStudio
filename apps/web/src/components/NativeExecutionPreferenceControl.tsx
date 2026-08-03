import { useMemo, useState } from "react";
import type { AgentFramework, NativeExecutionPreference } from "@opc/shared";
import type { FeatureFlagValues } from "@opc/shared";
import { AlertTriangle, Blocks, Route } from "lucide-react";
import { useT } from "../i18n.js";
import { readWebFeatureFlags } from "../features/ecosystem/runtimeFlags.js";

const WEB_VERSION = "0.1.0";

export type NativeExecutionFeatureFlags = Pick<
  FeatureFlagValues,
  "OPC_CODEX_NATIVE_ADAPTER" | "OPC_CLAUDE_NATIVE_ADAPTER"
>;

export interface NativeExecutionChoice {
  preference: NativeExecutionPreference["preference"];
  enabled: boolean;
  reason?: "feature_disabled" | "framework_mismatch";
}

export function resolveNativeExecutionChoices(
  flags: NativeExecutionFeatureFlags,
  framework?: AgentFramework,
): NativeExecutionChoice[] {
  return [
    { preference: "acp", enabled: true },
    {
      preference: "codex-native",
      enabled: flags.OPC_CODEX_NATIVE_ADAPTER && (!framework || framework === "codex"),
      reason: !flags.OPC_CODEX_NATIVE_ADAPTER
        ? "feature_disabled"
        : framework && framework !== "codex" ? "framework_mismatch" : undefined,
    },
    {
      preference: "claude-native",
      enabled: flags.OPC_CLAUDE_NATIVE_ADAPTER && (!framework || framework === "claude-code"),
      reason: !flags.OPC_CLAUDE_NATIVE_ADAPTER
        ? "feature_disabled"
        : framework && framework !== "claude-code" ? "framework_mismatch" : undefined,
    },
  ];
}

function readNativeFlags(): NativeExecutionFeatureFlags {
  const flags = readWebFeatureFlags(WEB_VERSION, import.meta.env as Readonly<Record<string, unknown>>);
  return {
    OPC_CODEX_NATIVE_ADAPTER: flags.OPC_CODEX_NATIVE_ADAPTER,
    OPC_CLAUDE_NATIVE_ADAPTER: flags.OPC_CLAUDE_NATIVE_ADAPTER,
  };
}

export default function NativeExecutionPreferenceControl({
  value,
  inheritedValue,
  onChange,
  framework,
  scope,
  featureFlags,
}: {
  value?: NativeExecutionPreference;
  inheritedValue?: NativeExecutionPreference;
  onChange: (next: NativeExecutionPreference) => Promise<void> | void;
  framework?: AgentFramework;
  scope: "company" | "agent";
  featureFlags?: NativeExecutionFeatureFlags;
}) {
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inherited = scope === "agent" && value === undefined;
  const resolved = value ?? inheritedValue ?? { preference: "acp", fallback: "acp" };
  const flags = useMemo(() => featureFlags ?? readNativeFlags(), [featureFlags]);
  const choices = useMemo(() => resolveNativeExecutionChoices(flags, framework), [flags, framework]);

  const save = async (next: NativeExecutionPreference) => {
    if (busy || (next.preference === resolved.preference && next.fallback === resolved.fallback)) return;
    setBusy(true);
    setError("");
    try {
      await onChange(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const labelKey = (preference: NativeExecutionPreference["preference"]) =>
    preference === "acp" ? "nativeExecution.option.acp"
      : preference === "codex-native" ? "nativeExecution.option.codex"
      : "nativeExecution.option.claude";

  return (
    <section className="rounded-lg border border-hairline bg-surface-1 p-3" data-native-execution-scope={scope}>
      <div className="flex items-start gap-2">
        <Route size={15} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <div className="text-[12px] font-semibold text-ink">{tr("nativeExecution.title")}</div>
            {inherited && (
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[9px] font-medium text-ink-muted">
                {tr("nativeExecution.inherited")}
              </span>
            )}
          </div>
          <p className="mt-0.5 mb-0 text-[11px] leading-relaxed text-ink-muted">
            {tr(scope === "company" ? "nativeExecution.companyHint" : "nativeExecution.agentHint")}
          </p>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-1.5" role="group" aria-label={tr("nativeExecution.title")}>
        {choices.map((choice) => {
          const selected = resolved.preference === choice.preference;
          const reason = choice.reason === "feature_disabled"
            ? tr("nativeExecution.unavailable.flag")
            : choice.reason === "framework_mismatch"
              ? tr("nativeExecution.unavailable.framework", { framework: framework ?? "-" })
              : undefined;
          return (
            <button
              key={choice.preference}
              type="button"
              disabled={busy || !choice.enabled}
              title={reason ?? tr(labelKey(choice.preference))}
              aria-pressed={selected}
              onClick={() => void save({ preference: choice.preference, fallback: choice.preference === "acp" ? "acp" : resolved.fallback })}
              className={`min-h-9 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                selected
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-hairline bg-surface-2 text-ink-muted hover:border-ink-subtle hover:text-ink"
              } disabled:cursor-not-allowed disabled:opacity-45`}
            >
              {tr(labelKey(choice.preference))}
            </button>
          );
        })}
      </div>

      {resolved.preference !== "acp" && (
        <div className="mt-3">
          <div className="mb-1.5 text-[11px] font-medium text-ink-muted">{tr("nativeExecution.fallback.title")}</div>
          <div className="grid grid-cols-2 gap-1.5" role="group" aria-label={tr("nativeExecution.fallback.title")}>
            {(["acp", "blocked"] as const).map((fallback) => (
              <button
                key={fallback}
                type="button"
                disabled={busy}
                aria-pressed={resolved.fallback === fallback}
                onClick={() => void save({ ...resolved, fallback })}
                className={`min-h-8 rounded-md border px-2 py-1 text-[11px] transition-colors ${
                  resolved.fallback === fallback
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-hairline bg-surface-2 text-ink-muted hover:border-ink-subtle hover:text-ink"
                } disabled:cursor-wait disabled:opacity-60`}
              >
                {tr(fallback === "acp" ? "nativeExecution.fallback.acp" : "nativeExecution.fallback.blocked")}
              </button>
            ))}
          </div>
          <p className="mt-1.5 mb-0 text-[10px] leading-relaxed text-ink-subtle">
            {tr(resolved.fallback === "acp" ? "nativeExecution.fallback.acpHint" : "nativeExecution.fallback.blockedHint")}
          </p>
        </div>
      )}

      {resolved.preference !== "acp" && !choices.find((choice) => choice.preference === resolved.preference)?.enabled && (
        <div className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-amber">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>{tr("nativeExecution.currentUnavailable")}</span>
        </div>
      )}
      {resolved.fallback === "blocked" && resolved.preference !== "acp" && (
        <div className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-ink-muted">
          <Blocks size={12} className="mt-0.5 shrink-0" />
          <span>{tr("nativeExecution.blockedNotice")}</span>
        </div>
      )}
      {error && <div className="mt-2 text-[10px] leading-relaxed text-red">{tr("nativeExecution.saveFailed", { error })}</div>}
    </section>
  );
}
