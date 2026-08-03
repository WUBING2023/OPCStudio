import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Download, FileQuestion } from "lucide-react";
import { useT } from "../../i18n.js";

const IMG = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "avif"]);
const VIDEO = new Set(["mp4", "webm", "ogv", "mov", "mkv", "m4v"]);
const AUDIO = new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus"]);

// 文件查看器:md→渲染;代码/文本→<pre>;pdf→iframe;图片→<img>;视频→<video>;音频→<audio>;其余二进制→下载。
export default function FileViewer({ path, ext }: { path: string; ext: string }) {
  const tr = useT();
  const url = `/api/file?path=${encodeURIComponent(path)}`;
  const isPdf = ext === "pdf";
  const isImg = IMG.has(ext);
  const isVideo = VIDEO.has(ext);
  const isAudio = AUDIO.has(ext);
  const isMd = ext === "md" || ext === "markdown";
  const media = isPdf || isImg || isVideo || isAudio;
  const [text, setText] = useState<string | null>(null);
  const [binary, setBinary] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (media) return;
    let alive = true;
    setText(null); setErr(null); setBinary(false);
    fetch(url)
      .then(async (r) => {
        if (!alive) return;
        const ct = r.headers.get("content-type") || "";
        if (ct.includes("application/json")) { const d = await r.json(); if (d.error) setErr(d.error); else setText(d.text ?? ""); }
        else setBinary(true); // 非 JSON = 服务端按二进制流式返回 → 给下载入口
      })
      .catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isPdf) return <iframe src={url} title={path} className="w-full h-full border-none" />;
  if (isImg) return <div className="h-full overflow-auto p-3 bg-surface-0"><img src={url} alt={path} className="max-w-full" /></div>;
  if (isVideo) return <div className="h-full flex items-center justify-center p-3 bg-surface-0"><video src={url} controls className="max-w-full max-h-full rounded" /></div>;
  if (isAudio) return <div className="h-full flex flex-col items-center justify-center gap-3 p-4 bg-surface-0"><div className="text-[11px] text-ink-subtle font-mono truncate max-w-full">{path.split("/").pop()}</div><audio src={url} controls className="w-full max-w-md" /></div>;
  if (err) return <div className="p-3 text-[12px] text-red">{err}</div>;
  if (binary) return (
    <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center bg-surface-0">
      <FileQuestion size={32} className="text-ink-subtle" />
      <div className="text-[12px] text-ink-muted">{tr("cockpit.cannotPreview", { ext: ext || "?" })}</div>
      <a href={url} download className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] no-underline btn-primary"><Download size={13} /> {tr("cockpit.downloadFile")}</a>
    </div>
  );
  if (text === null) return <div className="p-3 text-[12px] text-ink-subtle">{tr("cockpit.loadingEllipsis")}</div>;

  return (
    <div className="h-full overflow-auto p-4 bg-surface-0">
      <div className="text-[10px] text-ink-subtle font-mono mb-2 truncate flex items-center justify-between gap-2">
        <span className="truncate">{path}</span>
        <a href={url} download title={tr("cockpit.download")} className="shrink-0 text-ink-subtle hover:text-accent"><Download size={12} /></a>
      </div>
      {isMd
        ? <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>
        : <pre className="text-[12px] whitespace-pre-wrap break-words font-mono text-ink-muted leading-relaxed">{text}</pre>}
    </div>
  );
}
