// 设置页夜间模式：日间用的深灰字不能原样留在深色底上。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function darkRules(): Array<{ selectors: string[]; body: string }> {
  const css = readFileSync(resolve("src/options/options.css"), "utf8");
  const start = css.indexOf("@media (prefers-color-scheme: dark)");
  const end = css.indexOf("@media (max-width:", start);
  const dark = css.slice(start, end === -1 ? undefined : end);
  return [...dark.matchAll(/([^{}]+)\{([^}]+)\}/g)].map((match) => ({
    selectors: (match[1] ?? "").split(",").map((selector) => selector.trim()),
    body: match[2] ?? "",
  }));
}

function colorOf(selector: string): string | undefined {
  const rule = darkRules().find((item) => item.selectors.includes(selector));
  return /color:\s*(#[0-9a-f]{6})/i.exec(rule?.body ?? "")?.[1];
}

describe("设置页夜间模式", () => {
  it("引导、字段名、勾选和说明都改成浅色字", () => {
    for (const selector of [
      ".onboarding-list",
      ".field",
      ".toggle",
      ".hero > p:last-child",
      ".privacy-note",
      ".list-row strong",
    ]) {
      const color = colorOf(selector)?.toLowerCase();
      expect(color, selector).toBeDefined();
      // 浅色字的通道值要明显高于日间正文 #3f4449。
      const channel = Number.parseInt(color!.slice(1, 3), 16);
      expect(channel, `${selector} ${color}`).toBeGreaterThan(0x90);
    }
  });

  it("夜间分隔线、输入框和当前菜单跟深色底分开", () => {
    const css = readFileSync(resolve("src/options/options.css"), "utf8");
    const start = css.indexOf("@media (prefers-color-scheme: dark)");
    const end = css.indexOf("@media (max-width:", start);
    const dark = css.slice(start, end);
    expect(dark).toContain(".setting-row + .setting-row");
    expect(dark).toContain("rgba(255, 255, 255, 0.12)");
    expect(dark).toContain("background-color: #2c2c2e");
    expect(dark).toContain("background: #3a3a3c");
  });

  it("内容区居中，窄屏改成单列", () => {
    const css = readFileSync(resolve("src/options/options.css"), "utf8");
    expect(css).toContain("width: min(1320px, 100%)");
    expect(css).toContain("width: 240px");
    expect(css).not.toContain("grid-template-columns: 168px");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)");
    expect(css).toContain("@media (max-width: 900px)");
    expect(css).toContain("@media (max-width: 720px)");
    expect(css).not.toContain("@media (min-width: 1800px)");
    expect(css).not.toContain("grid-column: 3");
  });
});
