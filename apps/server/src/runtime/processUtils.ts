import { spawnSync } from "node:child_process";

// Kill a process and its entire tree.
//
// On Windows, `taskkill /PID <pid> /T /F` walks the OS process tree and force-terminates every
// descendant (e.g. Python subprocesses spawned by Hermes).  `proc.kill()` only kills the
// direct child — on Windows it sends WM_CLOSE which Hermes/Python children can ignore; when the
// parent exits the children become orphans and keep running.
//
// On non-Windows (or if pid is undefined): only the fallback kill() is called.
//
// The `kill` callback is ALWAYS called as belt-and-suspenders: even when taskkill succeeds,
// we still prod the Node ChildProcess handle so it is marked dead in Node's bookkeeping and
// no further events arrive.
//
// Never throws — all failures (taskkill missing, process already gone, etc.) are swallowed so
// callers stay in the "try { proc.kill() } catch {}" safety zone.
export function killProcessTree(pid: number | undefined, kill: () => void): void {
  if (process.platform === "win32" && pid != null) {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 5000, // guard: taskkill should finish in milliseconds
      });
    } catch {
      // taskkill not on PATH (very unusual) or process already gone before we got here
    }
  }
  try { kill(); } catch { /* process already gone — not an error */ }
}
