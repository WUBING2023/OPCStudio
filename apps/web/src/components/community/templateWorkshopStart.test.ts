import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import TemplateWorkshop, { WorkshopStartScreen } from "./TemplateWorkshop.js";
import { DICTS } from "../../i18n.js";

const noop = () => {};
const HINT = DICTS.en["tw.startHint"];
const BLANK = DICTS.en["tw.startBlank"];

describe("WorkshopStartScreen · 预选公司导出的加载/失败态(#31)", () => {
  it("busy:整屏 spinner,不渲染三选一", () => {
    const html = renderToString(createElement(WorkshopStartScreen, {
      busy: true, error: null, onBlank: noop, onFromCompany: noop, onFork: noop,
    }));
    expect(html).toContain("animate-spin");
    expect(html).not.toContain(HINT);
  });

  it("error:首屏渲染错误文案,三选一仍在", () => {
    const html = renderToString(createElement(WorkshopStartScreen, {
      busy: false, error: "export boom 500", onBlank: noop, onFromCompany: noop, onFork: noop,
    }));
    expect(html).toContain("export boom 500");
    expect(html).toContain(HINT);
    expect(html).toContain(BLANK);
  });

  it("常态:无 spinner 无错误,三选一", () => {
    const html = renderToString(createElement(WorkshopStartScreen, {
      busy: false, error: null, onBlank: noop, onFromCompany: noop, onFork: noop,
    }));
    expect(html).not.toContain("animate-spin");
    expect(html).toContain(HINT);
  });
});

describe("TemplateWorkshop · 挂载首帧(#31)", () => {
  it("带 initialCompanyId:首帧就是加载态,而不是三选一首屏", () => {
    const html = renderToString(createElement(TemplateWorkshop, {
      onClose: noop, onSaved: noop, initialCompanyId: "c1",
    }));
    expect(html).toContain("animate-spin");
    expect(html).not.toContain(HINT);
  });

  it("不带 initialCompanyId:三选一首屏,无加载态", () => {
    const html = renderToString(createElement(TemplateWorkshop, { onClose: noop, onSaved: noop }));
    expect(html).toContain(HINT);
    expect(html).not.toContain("animate-spin");
  });
});
