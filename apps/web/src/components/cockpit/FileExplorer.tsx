import { useEffect, useState, useRef } from "react";
import { Folder, FileText, ArrowUp, RefreshCw, Home, FolderOpen } from "lucide-react";
import { useT } from "../../i18n.js";

interface Entry { name: string; path: string; type: "dir" | "file"; ext: string; size: number; }

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

const LAST_DIR_KEY = "opc-fx-dir";

// 工作文件浏览器:默认从当前员工所属公司的绑定工作目录打开。服务端只允许 projectRoot/已绑定公司目录，且隐藏密钥凭证。
export default function FileExplorer({ onOpen, root = "." }: { onOpen: (path: string, ext: string) => void; root?: string }) {
  const tr = useT();
  const [dir, setDir] = useState<string>(root);
  const [curAbs, setCurAbs] = useState<string>("");
  const [pathInput, setPathInput] = useState<string>("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => { setDir(root || "."); }, [root]);

  useEffect(() => {
    let alive = true;
    setErr(null);
    fetch(`/api/files?dir=${encodeURIComponent(dir)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d.error) { setErr(d.error); return; }
        setEntries(d.entries || []);
        const abs = d.dir || dir;
        setCurAbs(abs); setPathInput(abs);
        try { localStorage.setItem(LAST_DIR_KEY, abs); } catch { /* */ }
      })
      .catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, [dir, nonce]);

  const dirInputRef = useRef<HTMLInputElement>(null);
  // 文件夹管理器选择:用 webkitdirectory 触发系统文件夹选择,从所选文件夹里第一个文件的 path 反推出文件夹绝对路径。
  const onPickDir = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] as (File & { path?: string }) | undefined;
    if (f?.path) {
      const full = f.path.replace(/\\/g, "/");
      const rel = (f.webkitRelativePath || "").replace(/\\/g, "/");
      const folder = rel ? full.slice(0, full.length - rel.length) + rel.split("/")[0] : full;
      if (folder) setDir(folder);
    }
    e.target.value = "";
  };

  const goUp = () => {
    const p = curAbs.replace(/\/+$/, "");
    const i = p.lastIndexOf("/");
    if (i < 0) return;
    let up = i === 0 ? "/" : p.slice(0, i);
    if (/^[A-Za-z]:$/.test(up)) up += "/"; // 盘符补斜杠(M: → M:/)
    setDir(up);
  };
  const jump = () => { const v = pathInput.trim(); if (v) setDir(v); };
  const canUp = curAbs && !/^([A-Za-z]:)?\/?$/.test(curAbs);

  return (
    <div className="h-full flex flex-col">
      <div className="px-2 py-1.5 flex items-center gap-1.5 border-b border-hairline shrink-0">
        <button onClick={goUp} disabled={!canUp} title={tr("cockpit.parentDir")}
          className="w-6 h-6 flex items-center justify-center rounded-lg border-none bg-transparent text-ink-muted hover:bg-surface-2 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed shrink-0">
          <ArrowUp size={13} />
        </button>
        <button onClick={() => setDir(root || ".")} title={tr("cockpit.backToProjectRoot")}
          className="w-6 h-6 flex items-center justify-center rounded-lg border-none bg-transparent text-ink-muted hover:bg-surface-2 cursor-pointer shrink-0">
          <Home size={12} />
        </button>
        <button onClick={() => dirInputRef.current?.click()} title={tr("cockpit.chooseFolderPicker")}
          className="w-6 h-6 flex items-center justify-center rounded-lg border-none bg-transparent text-ink-muted hover:bg-surface-2 cursor-pointer shrink-0">
          <FolderOpen size={13} />
        </button>
        <input ref={dirInputRef} type="file" {...({ webkitdirectory: "", directory: "" } as any)} className="hidden" onChange={onPickDir} />
        <input
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") jump(); }}
          onBlur={jump}
          title={tr("cockpit.pathInputHint")}
          spellCheck={false}
          className="flex-1 min-w-0 font-mono text-[11px] text-ink bg-surface-0 border border-hairline rounded px-2 py-1 outline-none focus:border-accent"
        />
        <button onClick={() => setNonce((n) => n + 1)} title={tr("cockpit.refresh")}
          className="w-6 h-6 flex items-center justify-center rounded-lg border-none bg-transparent text-ink-muted hover:bg-surface-2 cursor-pointer shrink-0">
          <RefreshCw size={12} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {err ? (
          <div className="p-3 text-[12px] text-red">{err}</div>
        ) : entries.length === 0 ? (
          <div className="p-3 text-[12px] text-ink-subtle">{tr("cockpit.emptyDir")}</div>
        ) : (
          entries.map((e) => (
            <button key={e.path}
              onClick={() => (e.type === "dir" ? setDir(e.path) : onOpen(e.path, e.ext))}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left border-none bg-transparent hover:bg-surface-2 cursor-pointer">
              {e.type === "dir"
                ? <Folder size={14} className="shrink-0 text-ink-muted" />
                : <FileText size={14} className="shrink-0 text-ink-subtle" />}
              <span className="text-[12px] text-ink truncate flex-1">{e.name}</span>
              {e.type === "file" && <span className="text-[10px] text-ink-subtle shrink-0">{fmtSize(e.size)}</span>}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
