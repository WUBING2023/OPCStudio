import * as fs from "node:fs";
import * as path from "node:path";

const backupPath = (filepath: string): string => `${filepath}.bak`;

function recoverInterruptedPublish(filepath: string): void {
  const backup = backupPath(filepath);
  if (!fs.existsSync(backup)) return;
  if (!fs.existsSync(filepath)) {
    fs.renameSync(backup, filepath);
    return;
  }
  // Both files means the new atomic publish completed before cleanup.
  fs.rmSync(backup, { force: true });
}

// Persist the replacement before moving the previous value aside. The backup
// closes the Windows rename fallback crash window and is recovered on read.
export function writeJSON(filepath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  recoverInterruptedPublish(filepath);

  const tmp = `${filepath}.tmp-${process.pid}-${Date.now()}`;
  const backup = backupPath(filepath);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");

  try {
    fs.renameSync(tmp, filepath);
    return;
  } catch (firstError) {
    if (!fs.existsSync(filepath)) throw firstError;
  }

  let previousMoved = false;
  try {
    fs.rmSync(backup, { force: true });
    fs.renameSync(filepath, backup);
    previousMoved = true;
    fs.renameSync(tmp, filepath);
    fs.rmSync(backup, { force: true });
  } catch (error) {
    if (previousMoved && fs.existsSync(backup)) {
      try {
        fs.rmSync(filepath, { force: true });
        fs.renameSync(backup, filepath);
      } catch {
        // Leave the backup in place. readJSON will retry recovery next time.
      }
    }
    throw error;
  }
}

// Parse failures preserve the original bytes as evidence and return the caller
// fallback. Missing files are normal and do not create a corrupt copy.
export function readJSON<T>(filepath: string, fallback: T): T {
  let raw: string;
  try {
    recoverInterruptedPublish(filepath);
    raw = fs.readFileSync(filepath, "utf-8");
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch {
    try {
      fs.copyFileSync(filepath, `${filepath}.corrupt-${Date.now()}`);
    } catch {
      // Evidence preservation must not hide the readable fallback.
    }
    return fallback;
  }
}
