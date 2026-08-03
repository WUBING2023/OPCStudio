import { DOWNLOADABLE, artifactDisplayStatus, type RunArtifact } from "../components/trace/traceTypes.js";

// 成果卡"打开能力"的纯派生口径——从 ResultSection.tsx 抽出成可单测的纯函数,锁住"何时该显示
// 预览/下载/复制按钮""何时如实显示无交付物"两处判定,避免视图里散落逻辑被静默改动。

// 后端 artifacts.json 带 savedPath(归档实体副本相对 run 目录的路径);traceTypes.RunArtifact 未声明该字段
// (那份是列表卡的最小形状),这里在成果卡消费侧局部扩展,读运行时真实存在的字段而不改动公共类型。
export type OpenableArtifact = RunArtifact & { savedPath?: string };

// 可打开(预览/下载/复制)判定——与服务端 resolveArtifactDownload 同口径:
// ①展示态须在 DOWNLOADABLE(final/degraded/accepted/added/modified)内,deleted/rejected 一律不可开;
// ②report/file 服务端有主源(report.md / 工作区文件)可开;
// ③其余 kind(worker-output 等)只有归档实体(savedPath)在时才可开——不展示点了就 404 的假按钮。
export function isArtifactOpenable(a: OpenableArtifact): boolean {
  const displayStatus = artifactDisplayStatus(a);
  if (!DOWNLOADABLE.has(displayStatus)) return false;
  if (a.kind === "report" || a.kind === "file") return true;
  return !!a.savedPath;
}

// 是否有交付物:无任何 artifact 时成果卡如实显示"无交付物",不装样子。
export function hasDeliverables(artifacts: OpenableArtifact[]): boolean {
  return artifacts.length > 0;
}

// 预览渲染模式:markdown 走富文本渲染,其余按纯文本(pre)展示。
export function isMarkdownPreview(filename: string | undefined): boolean {
  return !!filename && /\.(md|markdown)$/i.test(filename);
}
