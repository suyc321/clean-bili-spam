import { describe, expect, it } from "vitest";
import { ENDPOINT_PRESETS } from "../src/options/endpoint-presets";

describe("常见接口地址", () => {
  it("每条都是 https 基址，名字和地址不重复", () => {
    const names = new Set<string>();
    const endpoints = new Set<string>();
    expect(ENDPOINT_PRESETS.length).toBeGreaterThan(8);
    for (const preset of ENDPOINT_PRESETS) {
      expect(preset.endpoint.startsWith("https://")).toBe(true);
      expect(preset.endpoint.endsWith("/")).toBe(false);
      expect(names.has(preset.name)).toBe(false);
      expect(endpoints.has(preset.endpoint)).toBe(false);
      names.add(preset.name);
      endpoints.add(preset.endpoint);
    }
    expect(names.has("DeepSeek")).toBe(true);
    expect(names.has("Anthropic")).toBe(true);
    expect(
      ENDPOINT_PRESETS.find((preset) => preset.name === "Anthropic")?.format,
    ).toBe("anthropic");
  });
});
