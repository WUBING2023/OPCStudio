// 报告/交付物 markdown → 真 .docx(OOXML)导出。
//
// 选型:docx(纯 JS,浏览器可直接 Packer.toBlob())+ marked(只用 .lexer() 拿结构化 AST,不用它的
// HTML 渲染路径——渲染进 DOM 需要 innerHTML,markdown 里混入的原始 HTML 标签会变成 XSS 面,详见
// printExport.tsx 顶部注释同一个理由)。两个包都用动态 import():这个文件本身体积很小,真正的重量
// (docx ~400KB、marked ~41KB,压缩前,均未过 1MB 红线)只在用户真的点"导出"时才按需拉取,不进首屏包。
//
// 中文支持:docx 生成的是 OOXML 文本节点(UTF-8),不涉及字体内嵌——Word/WPS 打开时按 w:eastAsia
// 走系统东亚字体回退,天然支持中文,不用像 PDF 方案那样操心字体资源。
import type { Token, Tokens } from "marked";

type DocxNS = typeof import("docx");

async function tokenize(markdown: string): Promise<Token[]> {
  const { marked } = await import("marked");
  return marked.lexer(markdown) as Token[];
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

interface InlineStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
}

// 内联 token(strong/em/codespan/link/…)→ docx Run 数组,递归叠加样式(粗体套斜体等)。
function inlineToRuns(tokens: Token[] | undefined, style: InlineStyle, docx: DocxNS): (InstanceType<DocxNS["TextRun"]> | InstanceType<DocxNS["ExternalHyperlink"]>)[] {
  if (!tokens || tokens.length === 0) return [];
  const runs: (InstanceType<DocxNS["TextRun"]> | InstanceType<DocxNS["ExternalHyperlink"]>)[] = [];
  for (const tok of tokens) {
    switch (tok.type) {
      case "text": {
        const t = tok as Tokens.Text;
        if (t.tokens && t.tokens.length) runs.push(...inlineToRuns(t.tokens, style, docx));
        else if (t.text) runs.push(new docx.TextRun({ text: t.text, bold: style.bold, italics: style.italics, strike: style.strike }));
        break;
      }
      case "strong":
        runs.push(...inlineToRuns((tok as Tokens.Strong).tokens, { ...style, bold: true }, docx));
        break;
      case "em":
        runs.push(...inlineToRuns((tok as Tokens.Em).tokens, { ...style, italics: true }, docx));
        break;
      case "del":
        runs.push(...inlineToRuns((tok as Tokens.Del).tokens, { ...style, strike: true }, docx));
        break;
      case "codespan":
        runs.push(new docx.TextRun({
          text: (tok as Tokens.Codespan).text, font: "Consolas",
          shading: { type: docx.ShadingType.CLEAR, color: "auto", fill: "F0F0F2" },
        }));
        break;
      case "link": {
        const l = tok as Tokens.Link;
        const inner = inlineToRuns(l.tokens, { ...style }, docx);
        const children = inner.length ? inner : [new docx.TextRun({ text: l.text || l.href })];
        // ExternalHyperlink 只接受 TextRun[],已生成的链接内文本不会再嵌套链接,断言安全。
        runs.push(new docx.ExternalHyperlink({ link: l.href, children: children as InstanceType<DocxNS["TextRun"]>[] }));
        break;
      }
      case "br":
        runs.push(new docx.TextRun({ text: "", break: 1 }));
        break;
      case "escape":
        runs.push(new docx.TextRun({ text: (tok as Tokens.Escape).text }));
        break;
      case "image":
        runs.push(new docx.TextRun({ text: `[${(tok as Tokens.Image).text || "image"}]`, italics: true }));
        break;
      default: {
        const generic = tok as Tokens.Generic;
        if (typeof generic.text === "string" && generic.text) runs.push(new docx.TextRun({ text: generic.text, bold: style.bold, italics: style.italics }));
      }
    }
  }
  return runs;
}

const HEADING_LEVELS: (keyof DocxNS["HeadingLevel"])[] = ["HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6"];
// 每个"独立"的顶层有序列表(不是同一列表内的嵌套子列表)必须有自己的 numbering reference——
// 否则多个列表会共享同一条 numId 编号链,第二个及之后的列表接着上一个继续编号而不是从 1 重新开始
// (docx/OOXML 里一个 numId 就是一条编号实例,同一实例只会有一条连续计数)。renderBlocks 每遇到一个
// 顶层 list token 就用 orderedListRefs.length 生成一个新 reference 并登记;同一列表内递归下钻的
// 嵌套子列表(renderList 内部的 nestedLists)复用同一个 reference、level+1——这是 Word 多级列表的
// 正确做法(同一 numId 下更深 level 的计数天然独立且回到浅层时自动重置)。
const ORDERED_LIST_REF = "opc-export-ordered-list";

interface BlockCtx {
  indent: number;   // twips
  italic?: boolean;
}

function renderCode(code: Tokens.Code, docx: DocxNS, ctx: BlockCtx): InstanceType<DocxNS["Paragraph"]>[] {
  const lines = code.text.split("\n");
  return lines.map((line, i) => new docx.Paragraph({
    children: [new docx.TextRun({ text: line.length ? line : " ", font: "Consolas", size: 18 })],
    shading: { type: docx.ShadingType.CLEAR, color: "auto", fill: "F0F0F2" },
    indent: ctx.indent ? { left: ctx.indent } : undefined,
    spacing: { before: i === 0 ? 120 : 0, after: i === lines.length - 1 ? 120 : 0, line: 260 },
  }));
}

function renderTable(table: Tokens.Table, docx: DocxNS): InstanceType<DocxNS["Table"]> {
  const headerRow = new docx.TableRow({
    tableHeader: true,
    children: table.header.map((cell) => new docx.TableCell({
      shading: { type: docx.ShadingType.CLEAR, color: "auto", fill: "E8E8EE" },
      children: [new docx.Paragraph({ children: inlineToRuns(cell.tokens, { bold: true }, docx) })],
    })),
  });
  const bodyRows = table.rows.map((row) => new docx.TableRow({
    children: row.map((cell) => new docx.TableCell({
      children: [new docx.Paragraph({ children: inlineToRuns(cell.tokens, {}, docx) })],
    })),
  }));
  return new docx.Table({ width: { size: 100, type: docx.WidthType.PERCENTAGE }, rows: [headerRow, ...bodyRows] });
}

function renderList(list: Tokens.List, docx: DocxNS, ctx: BlockCtx, level: number, ref: string): InstanceType<DocxNS["Paragraph"]>[] {
  const out: InstanceType<DocxNS["Paragraph"]>[] = [];
  for (const item of list.items) {
    const leadingInline: Token[] = [];
    const nestedLists: Tokens.List[] = [];
    for (const sub of item.tokens) {
      if (sub.type === "list") { nestedLists.push(sub as Tokens.List); continue; }
      const withTokens = sub as Tokens.Generic;
      if (Array.isArray(withTokens.tokens)) leadingInline.push(...withTokens.tokens);
      else if (typeof withTokens.text === "string" && withTokens.text) leadingInline.push({ type: "text", raw: withTokens.text, text: withTokens.text } as Tokens.Text);
    }
    const prefix = item.task ? `${item.checked ? "☑" : "☐"} ` : "";
    const runs = inlineToRuns(leadingInline, { italics: ctx.italic }, docx);
    out.push(new docx.Paragraph({
      children: prefix ? [new docx.TextRun({ text: prefix }), ...runs] : runs,
      ...(list.ordered
        ? { numbering: { reference: ref, level } }
        : { bullet: { level } }),
    }));
    // 同一列表内的嵌套子列表:复用同一个 ref,只加深 level(Word 多级列表的正确做法)。
    for (const nested of nestedLists) out.push(...renderList(nested, docx, ctx, level + 1, ref));
  }
  return out;
}

function renderBlocks(tokens: Token[], docx: DocxNS, ctx: BlockCtx, orderedListRefs: string[]): (InstanceType<DocxNS["Paragraph"]> | InstanceType<DocxNS["Table"]>)[] {
  const out: (InstanceType<DocxNS["Paragraph"]> | InstanceType<DocxNS["Table"]>)[] = [];
  for (const tok of tokens) {
    switch (tok.type) {
      case "heading": {
        const h = tok as Tokens.Heading;
        const level = HEADING_LEVELS[Math.min(Math.max(h.depth, 1), 6) - 1];
        out.push(new docx.Paragraph({
          heading: docx.HeadingLevel[level],
          children: inlineToRuns(h.tokens, {}, docx),
          spacing: { before: 240, after: 120 },
        }));
        break;
      }
      case "paragraph": {
        const p = tok as Tokens.Paragraph;
        out.push(new docx.Paragraph({
          children: inlineToRuns(p.tokens, { italics: ctx.italic }, docx),
          indent: ctx.indent ? { left: ctx.indent } : undefined,
          spacing: { after: 160, line: 300 },
        }));
        break;
      }
      case "list": {
        // 每个顶层 list token 都是文档里"独立"的一份列表,分配一个专属 numbering reference,
        // 避免和其他独立列表共享同一条编号链(见 ORDERED_LIST_REF 定义处的说明)。
        const ref = `${ORDERED_LIST_REF}-${orderedListRefs.length}`;
        orderedListRefs.push(ref);
        out.push(...renderList(tok as Tokens.List, docx, ctx, 0, ref));
        break;
      }
      case "table":
        out.push(renderTable(tok as Tokens.Table, docx));
        break;
      case "code":
        out.push(...renderCode(tok as Tokens.Code, docx, ctx));
        break;
      case "blockquote":
        out.push(...renderBlocks((tok as Tokens.Blockquote).tokens, docx, { indent: ctx.indent + 480, italic: true }, orderedListRefs));
        break;
      case "hr":
        out.push(new docx.Paragraph({
          border: { bottom: { style: docx.BorderStyle.SINGLE, size: 6, color: "CCCCCC", space: 1 } },
          spacing: { after: 200 },
        }));
        break;
      case "space":
      case "def":
      case "html":
        break; // 空行/link 定义/原始 HTML:不进 Word 正文
      default: {
        const generic = tok as Tokens.Generic;
        if (typeof generic.text === "string" && generic.text) out.push(new docx.Paragraph({ text: generic.text }));
      }
    }
  }
  return out;
}

// markdown → .docx 二进制并触发浏览器下载。filename 应含 .docx 后缀。
export async function exportMarkdownToDocx(markdown: string, filename: string): Promise<void> {
  const [docx, tokens] = await Promise.all([import("docx"), tokenize(markdown)]);
  const orderedListRefs: string[] = [];
  const body = renderBlocks(tokens, docx, { indent: 0 }, orderedListRefs);
  const levels = () => Array.from({ length: 6 }, (_, level) => ({
    level,
    format: docx.LevelFormat.DECIMAL,
    text: `%${level + 1}.`,
    alignment: docx.AlignmentType.START,
    style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 360 } } },
  }));
  const doc = new docx.Document({
    numbering: {
      // 每个独立列表一个 reference → 一个独立的 numId 编号实例,互不干扰各自从 1 开始。
      config: orderedListRefs.map((reference) => ({ reference, levels: levels() })),
    },
    sections: [{ children: body.length ? body : [new docx.Paragraph({ text: "" })] }],
  });
  const blob = await docx.Packer.toBlob(doc);
  triggerBlobDownload(blob, filename);
}
