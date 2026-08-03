import { createRoot, type Root } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// markdown → PDF,走浏览器/Electron 原生"打印到 PDF"而不是手写 PDF 排版(如 jsPDF)。
//
// 为什么不用 jsPDF:实测过——jsPDF 的标准字体(Helvetica 等)是 WinAnsi 单字节编码,不含 CJK 字形,
// 中文文本写进去会变成乱码(用 `doc.text("中文测试", ...)` 生成后查内容流,"中文测试"变成了乱码字节)。
// 要正确画中文必须内嵌一个 CJK 字体文件,常规子集也有 1MB+,与本次"不引入超过 1MB 的重型依赖"的
// 范围要求冲突;而这是一个中文优先的产品,PDF 导出如果中文是乱码等于没做。
//
// 浏览器 / Electron 底层都是 Chromium,打印引擎原生走系统字体,中文/日文/阿拉伯文都天然正确,产出
// 的是真矢量文本(可选中、可搜索),不是截图。这是需求里已经预先认可的备选方案。复用 ReactMarkdown +
// remarkGfm——和屏幕上 ResultSection 用的是同一套渲染组件——保证"打印出来的和屏幕看到的排版一致",
// 且不引入任何新依赖(react-dom/react-markdown/remark-gfm 都已经是现有打包的一部分)。
//
// 安全考量:没有走 marked.parse() 产出 HTML 字符串再 innerHTML 注入——那样 markdown 里混入的原始
// HTML 标签(<script>/事件属性等)会被当成真 DOM 执行,在 Electron 渲染进程里是一条 XSS 路径。
// ReactMarkdown 默认不渲染原始 HTML(转义成文本),和屏幕上报告区域的既有安全边界完全一致。
const PRINT_ROOT_ID = "opc-print-root";

function getOrCreatePrintRoot(): HTMLDivElement {
  let el = document.getElementById(PRINT_ROOT_ID) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement("div");
    el.id = PRINT_ROOT_ID;
    document.body.appendChild(el);
  }
  return el;
}

let activeRoot: Root | null = null;
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
let savedTitle = "";

function cleanup() {
  if (cleanupTimer) { clearTimeout(cleanupTimer); cleanupTimer = null; }
  window.removeEventListener("afterprint", cleanup);
  if (savedTitle) { document.title = savedTitle; savedTitle = ""; }
  const el = document.getElementById(PRINT_ROOT_ID);
  if (el) el.classList.remove("opc-print-active");
  // unmount 放到下一轮宏任务:某些环境 afterprint 在打印面板仍持有 DOM 引用时触发,
  // 立即 unmount 会在少数浏览器里报 "Cannot read from unmounted root" 的告警(非致命,但没必要冒这个险)。
  const root = activeRoot;
  activeRoot = null;
  if (root) setTimeout(() => root.unmount(), 0);
}

// title 会临时顶替 document.title——大多数浏览器/系统"打印到 PDF"用它做默认文件名建议。
export function printMarkdownAsPdf(markdown: string, title: string): void {
  cleanup(); // 防御:上一次导出还没清理干净就又点了一次
  const el = getOrCreatePrintRoot();
  el.classList.add("opc-print-active");
  activeRoot = createRoot(el);
  activeRoot.render(
    <div className="opc-print-doc">
      <h1 className="opc-print-title">{title}</h1>
      <div className="markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
      </div>
    </div>,
  );
  savedTitle = document.title;
  document.title = title;
  // React 18 createRoot 渲染是异步的;等两帧确保内容已经落到 DOM 上再触发打印,否则可能打出空白页。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.addEventListener("afterprint", cleanup, { once: true });
      cleanupTimer = setTimeout(cleanup, 10_000); // 兜底:部分环境不可靠地触发 afterprint
      window.print();
    });
  });
}
