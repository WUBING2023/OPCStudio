import { resolveFeatureFlags, type FeatureFlagValues } from "@opc/shared";

export const WEB_FEATURE_FLAGS_STORAGE_KEY = "opc-feature-flags";

export function resolveWebFeatureFlags(
  currentVersion: string,
  environment: Readonly<Record<string, unknown>>,
  persisted: unknown,
): FeatureFlagValues {
  return resolveFeatureFlags({ currentVersion, environment, persisted });
}

export function readWebFeatureFlags(
  currentVersion: string,
  environment: Readonly<Record<string, unknown>>,
): FeatureFlagValues {
  let persisted: unknown;
  try { persisted = localStorage.getItem(WEB_FEATURE_FLAGS_STORAGE_KEY); } catch { persisted = undefined; }
  return resolveWebFeatureFlags(currentVersion, environment, persisted);
}
