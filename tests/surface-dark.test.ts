// 弹出页和卡片弹出层的夜间字色必须明显高于深底，不能把日间深灰原样留下。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function darkBlock(file: string): string {
  const source = readFileSync(resolve(file), "utf8");
  const start = source.indexOf("@media (prefers-color-scheme: dark)");
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf("@media", start + 10);
  return source.slice(start, next === -1 ? undefined : next);
}

function channel(color: string): number {
  return Number.parseInt(color.slice(1, 3), 16);
}

describe("弹出页与弹出层夜间对比度", () => {
  it("弹出页的说明、分隔线和状态胶囊改成浅色", () => {
    const dark = darkBlock("src/popup/popup.css");
    expect(dark).toContain(".account-row");
    expect(dark).toContain("border-top-color: #3a3d46");
    expect(dark).toContain(".health-healthy");
    expect(dark).toContain(".row-state");
    for (const color of ["#d5dbe6", "#f2f4f8", "#e7f0ff"]) {
      expect(dark).toContain(color);
      expect(channel(color)).toBeGreaterThan(0x90);
    }
    expect(dark).toContain("#8ddeb4");
    expect(dark).not.toContain("#9499a0");
    expect(dark).not.toContain("#61666d");
  });

  it("弹出层的说明、证据不足和粉丝行都有浅色字", () => {
    const dark = darkBlock("src/content/badge-renderer.ts");
    for (const selector of [
      ".meta",
      ".meta.audience",
      ".notice.ai-gaps",
      ".notice.hint",
      ".notice.ai-notice.primary",
      ".block-confirm",
    ]) {
      expect(dark).toContain(selector);
    }
    for (const color of ["#d5dbe6", "#e4eaf4", "#e7f0ff", "#ffc1c4"]) {
      expect(dark).toContain(color);
      expect(channel(color)).toBeGreaterThan(0x90);
    }
    expect(dark).not.toContain("#9499a0");
    expect(dark).not.toContain("#61666d");
    expect(dark).not.toContain("#42474c");
  });
});
