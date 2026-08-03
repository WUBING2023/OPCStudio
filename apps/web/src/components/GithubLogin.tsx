import { useEffect, useRef, useState } from "react";
import { LogIn, Check, Copy, ExternalLink, LogOut, RefreshCw } from "lucide-react";
import * as api from "../api/client.js";

interface Status { connected: boolean; login?: string; source?: string | null; clientIdConfigured?: boolean; }
interface DeviceStart { deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete?: string; interval: number; expiresIn: number; }

function openExternal(url: string) {
  try { (window as any).opc?.openExternal?.(url); } catch { /* */ }
  try { window.open(url, "_blank", "noopener"); } catch { /* */ }
}

// per-user GitHub 登录(Device Flow):点登录 → 显示一串码 + 跳 github.com/login/device → 轮询直到授权完成。
export default function GithubLogin() {
  const [status, setStatus] = useState<Status | null>(null);
  const [dev, setDev] = useState<DeviceStart | null>(null);
  const [polling, setPolling] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = () => api.get<Status>("/github/status").then(setStatus).catch(() => setStatus(null));
  useEffect(() => { refresh(); return () => { if (timer.current) clearTimeout(timer.current); }; }, []);

  const start = async () => {
    setErr(null); setDev(null);
    try {
      const d = await api.post<DeviceStart>("/github/device/start", {});
      setDev(d);
      openExternal(d.verificationUriComplete || d.verificationUri);
      setPolling(true);
      poll(d.deviceCode, d.interval || 5);
    } catch (e: any) { setErr(e?.message || "启动登录失败"); }
  };

  const poll = (deviceCode: string, interval: number) => {
    timer.current = setTimeout(async () => {
      try {
        const r = await api.post<{ connected?: boolean; pending?: boolean; slowDown?: boolean; login?: string }>("/github/device/poll", { deviceCode });
        if (r.connected) { setPolling(false); setDev(null); refresh(); return; }
        poll(deviceCode, interval + (r.slowDown ? 5 : 0)); // slow_down → 加间隔
      } catch (e: any) { setPolling(false); setErr(e?.message || "授权失败/超时,请重试"); }
    }, interval * 1000);
  };

  const logout = async () => { await api.post("/github/logout", {}).catch(() => {}); setDev(null); setPolling(false); refresh(); };
  const copyCode = () => { if (dev) { navigator.clipboard?.writeText(dev.userCode).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); } };

  if (status?.connected) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green/10 text-green text-[12px] border border-green/20">
          <Check size={13} /> 已连接 GitHub{status.login ? ` · @${status.login}` : ""}{status.source === "env" ? "(env token)" : ""}
        </span>
        {status.source === "oauth" && (
          <button onClick={logout} className="inline-flex items-center gap-1 text-[12px] text-text-muted hover:text-red cursor-pointer bg-transparent border-none"><LogOut size={12} /> 断开</button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {!dev ? (
        <button onClick={start} className="inline-flex items-center gap-2 px-3.5 py-2 rounded-full bg-[#1f2328] text-white text-[13px] cursor-pointer border-none hover:opacity-90 w-fit">
          <LogIn size={15} /> 用 GitHub 登录
        </button>
      ) : (
        <div className="rounded-xl border border-border bg-bg-card p-3.5 flex flex-col gap-2 max-w-md">
          <div className="text-[12px] text-text-secondary">1) 在打开的 GitHub 页面输入这串码:</div>
          <div className="flex items-center gap-2">
            <code className="text-[18px] font-mono font-bold tracking-[0.2em] text-text-primary bg-bg-hover px-3 py-1.5 rounded-lg">{dev.userCode}</code>
            <button onClick={copyCode} title="复制" className="w-8 h-8 flex items-center justify-center rounded-lg bg-bg-hover text-text-muted hover:text-text-primary cursor-pointer border-none">{copied ? <Check size={14} className="text-green" /> : <Copy size={14} />}</button>
          </div>
          <button onClick={() => openExternal(dev.verificationUriComplete || dev.verificationUri)} className="inline-flex items-center gap-1.5 text-[12px] text-accent cursor-pointer bg-transparent border-none w-fit"><ExternalLink size={12} /> 没自动打开?点这里去 {dev.verificationUri}</button>
          <div className="text-[12px] text-text-muted flex items-center gap-1.5">{polling ? <><RefreshCw size={12} className="animate-spin" /> 等待你在 GitHub 授权…</> : "授权后自动完成"}</div>
        </div>
      )}
      {err && <div className="text-[12px] text-red">{err}</div>}
      {status && !status.clientIdConfigured && <div className="text-[11px] text-text-muted">未配置 OAuth Client ID(设置→关于,或内置默认)。</div>}
    </div>
  );
}
