// 本地名单状态测试：三类名单互斥写回与导入归一化的优先级消除。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExportBundle,
  getSettings,
  importBundle,
  setAccountDisposition,
} from "../src/storage/local-state";

const STORAGE_KEYS = {
  settings: "kcf:settings:v1",
  whitelist: "kcf:whitelist:v1",
  ignored: "kcf:ignored:v1",
  candidates: "kcf:candidates:v1",
} as const;

let storedValues: Record<string, unknown>;
let setCalls: Record<string, unknown>[];

describe("本地用户处置状态", () => {
  beforeEach(() => {
    storedValues = {};
    setCalls = [];
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async (keys: string | string[]) => {
            const requestedKeys = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(
              requestedKeys.map((key) => [key, storedValues[key]]),
            );
          },
          set: async (values: Record<string, unknown>) => {
            setCalls.push(values);
            Object.assign(storedValues, values);
          },
          remove: async () => undefined,
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("一次写回三份列表，并使同一账号只保留目标处置", async () => {
    storedValues[STORAGE_KEYS.whitelist] = [
      { accountKey: "uid:1", displayName: "旧名称", addedAtMs: 1 },
      { accountKey: "uid:1", displayName: "新名称", addedAtMs: 2 },
    ];
    storedValues[STORAGE_KEYS.ignored] = [
      { accountKey: "uid:1", ignoredAtMs: 3 },
      { accountKey: "uid:2", ignoredAtMs: 4 },
    ];
    storedValues[STORAGE_KEYS.candidates] = [
      {
        accountKey: "uid:2",
        uid: "2",
        aiProbability: 70,
        addedAtMs: 5,
      },
      {
        accountKey: "uid:3",
        uid: "3",
        aiProbability: 80,
        addedAtMs: 6,
      },
    ];
    vi.spyOn(Date, "now").mockReturnValue(100);

    const result = await setAccountDisposition({
      accountKey: "uid:2",
      uid: "2",
      displayName: "账号二",
      aiProbability: 92,
      disposition: "candidate",
      selected: true,
    });

    expect(result).toEqual({
      whitelist: [
        { accountKey: "uid:1", displayName: "新名称", addedAtMs: 2 },
      ],
      ignored: [],
      candidates: [
        {
          accountKey: "uid:3",
          uid: "3",
          aiProbability: 80,
          addedAtMs: 6,
        },
        {
          accountKey: "uid:2",
          uid: "2",
          displayName: "账号二",
          aiProbability: 92,
          addedAtMs: 100,
        },
      ],
    });
    expect(setCalls).toEqual([
      {
        [STORAGE_KEYS.whitelist]: result.whitelist,
        [STORAGE_KEYS.ignored]: result.ignored,
        [STORAGE_KEYS.candidates]: result.candidates,
      },
    ]);
  });

  it("导入时去重，并按白名单、忽略、待处理的优先级消除交叉", async () => {
    const result = await importBundle({
      formatVersion: 1,
      exportedAtMs: 100,
      settings: {
        showBadges: true,
        automaticallyDimHighRisk: false,
        retentionDays: 90,
        maxVideosPerAccount: 20,
      },
      whitelist: [
        { accountKey: "uid:1", displayName: "旧名称", addedAtMs: 1 },
        { accountKey: "uid:1", displayName: "新名称", addedAtMs: 2 },
      ],
      ignored: [
        { accountKey: "uid:1", ignoredAtMs: 3 },
        { accountKey: "uid:2", ignoredAtMs: 4 },
        { accountKey: "uid:2", ignoredAtMs: 5 },
      ],
      candidates: [
        {
          accountKey: "uid:1",
          uid: "1",
          aiProbability: 60,
          addedAtMs: 6,
        },
        {
          accountKey: "uid:2",
          uid: "2",
          aiProbability: 70,
          addedAtMs: 7,
        },
        {
          accountKey: "uid:3",
          uid: "3",
          aiProbability: 80,
          addedAtMs: 8,
        },
        {
          accountKey: "uid:3",
          uid: "3",
          aiProbability: 90,
          addedAtMs: 9,
        },
      ],
    });

    // 旧版导入文件里的阈值字段被忽略；设置收敛到归一化后的默认值。
    expect(result.settings).toMatchObject({
      showBadges: true,
      retentionDays: 90,
      maxVideosPerAccount: 20,
    });
    expect(result.settings).not.toHaveProperty("suspiciousThreshold");
    expect(result.settings).not.toHaveProperty("aiFallbackEnabled");
    expect(result.settings).not.toHaveProperty("aiFallbackApiKey");
    expect(result.whitelist).toEqual([
      { accountKey: "uid:1", displayName: "新名称", addedAtMs: 2 },
    ]);
    expect(result.ignored).toEqual([
      { accountKey: "uid:2", ignoredAtMs: 5 },
    ]);
    expect(result.candidates).toEqual([
      {
        accountKey: "uid:3",
        uid: "3",
        aiProbability: 90,
        addedAtMs: 9,
      },
    ]);
    expect(setCalls).toEqual([
      {
        [STORAGE_KEYS.settings]: result.settings,
        [STORAGE_KEYS.whitelist]: result.whitelist,
        [STORAGE_KEYS.ignored]: result.ignored,
        [STORAGE_KEYS.candidates]: result.candidates,
      },
    ]);
  });

  it("导入和读取都会丢掉已移除字段，并保留当前接口配置", async () => {
    const imported = await importBundle({
      formatVersion: 1,
      exportedAtMs: 100,
      settings: {
        aiEnabled: true,
        aiEndpoint: "https://api.openai.com/v1",
        aiApiKey: "sk-live",
        aiModel: "gpt-4o-mini",
        aiFallbackEnabled: true,
        aiFallbackEndpoint: "https://example.invalid/v1",
        aiFallbackApiKey: "old-key",
        aiFallbackModel: "old-model",
        aiFallbackFormat: "anthropic",
      },
      whitelist: [],
      ignored: [],
      candidates: [],
    });
    expect(imported.settings.aiEnabled).toBe(true);
    expect(imported.settings.aiEndpoint).toBe("https://api.openai.com/v1");
    expect(imported.settings.aiApiKey).toBe("sk-live");
    expect(imported.settings).not.toHaveProperty("aiFallbackEnabled");
    expect(imported.settings).not.toHaveProperty("aiFallbackApiKey");

    storedValues[STORAGE_KEYS.settings] = {
      aiEnabled: true,
      aiEndpoint: "https://api.deepseek.com/v1",
      aiApiKey: "sk-kept",
      aiModel: "deepseek-chat",
      aiFallbackApiKey: "still-on-disk",
    };
    const settings = await getSettings();
    expect(settings.aiEndpoint).toBe("https://api.deepseek.com/v1");
    expect(settings.aiApiKey).toBe("sk-kept");
    expect(settings).not.toHaveProperty("aiFallbackApiKey");
    const written = storedValues[STORAGE_KEYS.settings] as Record<string, unknown>;
    expect(written.aiApiKey).toBe("sk-kept");
    expect(written).not.toHaveProperty("aiFallbackApiKey");
  });

  it("导出文件不含 API Key，其余 AI 配置照常导出", async () => {
    storedValues[STORAGE_KEYS.settings] = {
      aiEnabled: true,
      aiEndpoint: "https://api.example.com/v1",
      aiApiKey: "sk-secret",
      aiModel: "m",
    };
    const bundle = await createExportBundle();
    expect(bundle.settings.aiApiKey).toBe("");
    expect(bundle.settings.aiEndpoint).toBe("https://api.example.com/v1");
    expect(JSON.stringify(bundle)).not.toContain("sk-secret");
  });

  it("导入不含 Key 的文件时保留本机已有的 API Key", async () => {
    storedValues[STORAGE_KEYS.settings] = {
      aiEndpoint: "https://api.example.com/v1",
      aiApiKey: "sk-local",
    };
    const imported = await importBundle({
      formatVersion: 1,
      exportedAtMs: 100,
      settings: { aiEndpoint: "https://api.example.com/v2", aiApiKey: "" },
      whitelist: [],
      ignored: [],
      candidates: [],
    });
    expect(imported.settings.aiEndpoint).toBe("https://api.example.com/v2");
    expect(imported.settings.aiApiKey).toBe("sk-local");
    expect((await getSettings()).aiApiKey).toBe("sk-local");
  });

  it("忽略名单写入时保留昵称（设置页靠它显示账号名）", async () => {
    const result = await setAccountDisposition({
      accountKey: "uid:7",
      uid: "7",
      displayName: "示例账号",
      disposition: "ignored",
      selected: true,
    });

    expect(result.ignored).toEqual([
      { accountKey: "uid:7", displayName: "示例账号", ignoredAtMs: expect.any(Number) },
    ]);
  });

  it("忽略昵称为空时退化成只有 accountKey 与时间戳", async () => {
    const result = await setAccountDisposition({
      accountKey: "uid:8",
      uid: "8",
      disposition: "ignored",
      selected: true,
    });

    expect(result.ignored).toEqual([
      { accountKey: "uid:8", ignoredAtMs: expect.any(Number) },
    ]);
  });

  it("历史忽略条目没有昵称也能读出来（不得整名单回退为空）", async () => {
    // 这是 IgnoreEntry 的 displayName 必须是可选字段的原因：
    // local-state 的 readArray/parseArray 在整数组校验失败时回退为空数组，
    // 设成必填会让用户已存的忽略名单静默清空。
    storedValues[STORAGE_KEYS.ignored] = [
      { accountKey: "uid:11", ignoredAtMs: 1 },
      { accountKey: "uid:12", displayName: "有昵称的", ignoredAtMs: 2 },
    ];

    const result = await setAccountDisposition({
      accountKey: "uid:99",
      uid: "99",
      disposition: "ignored",
      selected: true,
    });

    expect(result.ignored).toContainEqual({ accountKey: "uid:11", ignoredAtMs: 1 });
    expect(result.ignored).toContainEqual({
      accountKey: "uid:12",
      displayName: "有昵称的",
      ignoredAtMs: 2,
    });
  });
});
