import { afterEach, describe, expect, it } from "vitest";
import {
  bundleMigrations,
  migrateBundleViaRegistry,
  type BundleMigrationFn,
} from "@opc/shared";

const injectedVersions: string[] = [];

afterEach(() => {
  for (const version of injectedVersions.splice(0)) delete bundleMigrations[version];
});

describe("Wave 5 release gate: cross-version migration failures", () => {
  it("rejects an unsupported future version without mutating the source", () => {
    const source = { schema_version: "99.0.0", title: "future bundle" };
    const before = structuredClone(source);
    const result = migrateBundleViaRegistry(source);
    expect(result.ok).toBe(false);
    expect(result.appliedMigrations).toEqual([]);
    expect(result.errors?.join(" ")).toContain("99.0.0");
    expect(source).toEqual(before);
  });

  it("converts a throwing registered migration into an explicit fail-closed result", () => {
    const version = "0.2.99-wave5";
    injectedVersions.push(version);
    const migration: BundleMigrationFn = (raw) => {
      (raw as Record<string, unknown>).title = "mutated inside failed migration";
      throw new Error("forced cross-version migration failure");
    };
    bundleMigrations[version] = migration;
    const source = { schema_version: version, title: "original" };

    const result = migrateBundleViaRegistry(source);
    expect(result).toMatchObject({ ok: false, appliedMigrations: [] });
    expect(result.errors?.join(" ")).toContain("forced cross-version migration failure");
    expect(source.title).toBe("original");
  });
});
