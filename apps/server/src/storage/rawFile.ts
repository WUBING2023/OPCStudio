import * as fs from "node:fs";

export type BoundedTextRead =
  | { ok: true; text: string; size: number }
  | { ok: false; reason: "missing" | "not_file" | "file_too_large" | "read_failed"; error?: string };

/**
 * Read a bounded UTF-8 persistence input without hiding parse failures.
 * Migration and doctor code need the original bytes; readJSON is deliberately
 * unsuitable because it turns malformed legacy data into a fallback value.
 */
export function readBoundedUtf8File(file: string, maxBytes: number): BoundedTextRead {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { ok: false, reason: "not_file" };
    if (stat.size > maxBytes) return { ok: false, reason: "file_too_large" };
    return { ok: true, text: fs.readFileSync(file, "utf-8"), size: stat.size };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { ok: false, reason: "missing" };
    return { ok: false, reason: "read_failed", error: error instanceof Error ? error.message : String(error) };
  }
}
