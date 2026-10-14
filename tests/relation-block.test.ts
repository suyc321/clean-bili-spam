// 拉黑功能测试：B 站关系接口调用、本地审计存储、面板二次确认流程。
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchRelationAttribute,
  isBlockedAttribute,
  modifyRelation,
} from "../src/api/relation";
import {
  addBlockedAccount,
  getBlockedAccounts,
  isBlocked,
  removeBlockedAccount,
  BLOCKED_STORAGE_KEY,
} from "../src/storage/blocked";
import {
  describeCsrfFailure,
  readBilibiliCsrf,
} from "../src/application/relation";
import {
  refreshBlockedAccounts,
  removeAllBadges,
  renderBadge,
} from "../src/content/badge-renderer";
import type { ExtractedCard } from "../src/adapters/contract";
import type { AccountAnalysis } from "../src/domain/types";
import { DEFAULT_SETTINGS } from "../src/domain/settings";

let storedValues: Record<string, unknown>;

function installChromeStub(permissions: Record<string, boolean> = {}): void {
  storedValues = {};
  vi.stubGlobal("chrome", {
    permissions: {
      contains: async (request: { origins: string[] }) =>
        permissions[(request.origins ?? [])[0] ?? ""] === true,
      request: async () => false,
    },
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(requested.map((key) => [key, storedValues[key]]));
        },
        set: async (values: Record<string, unknown>) => {
          Object.assign(storedValues, values);
        },
        remove: async (key: string) => {
          delete storedValues[key];
        },
      },
    },
  });
}

describe("B 站关系接口", () => {
  it("拉黑请求带 act=5 与 CSRF，成功（code 0）不抛错", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 0, message: "0" }), { status: 200 }),
    );
    await modifyRelation("block", { uid: "123", csrf: "token123" }, fetchImpl);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.bilibili.com/x/relation/modify");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("fid")).toBe("123");
    expect(body.get("act")).toBe("5");
    expect(body.get("csrf")).toBe("token123");
  });

  it("取消拉黑使用 act=6", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 0 }), { status: 200 }),
    );
    await modifyRelation("unblock", { uid: "123", csrf: "token123" }, fetchImpl);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(new URLSearchParams(String(init.body)).get("act")).toBe("6");
  });

  it("接口返回非 0 code 时抛出中文错误", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: -101, message: "账号未登录" }), { status: 200 }),
    );
    await expect(
      modifyRelation("block", { uid: "123", csrf: "token123" }, fetchImpl),
    ).rejects.toThrow("账号未登录");
  });

  it("CSRF 为空时直接拒绝（不发请求）", async () => {
    const fetchImpl = vi.fn();
    await expect(
      modifyRelation("block", { uid: "123", csrf: "  " }, fetchImpl),
    ).rejects.toThrow("CSRF");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("拉黑记录存储", () => {
  beforeEach(() => {
    installChromeStub();
  });

  it("写入后可查询，重复写入同一账号只保留一条", async () => {
    const entry = {
      accountKey: "uid:100" as const,
      uid: "100",
      aiProbability: 85,
      band: "suspicious" as const,
      blockedAtMs: 1_000,
    };
    await addBlockedAccount(entry);
    await addBlockedAccount({ ...entry, blockedAtMs: 2_000 });

    const entries = await getBlockedAccounts();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.blockedAtMs).toBe(2_000);
    expect(await isBlocked("uid:100")).toBe(true);
    expect(await isBlocked("uid:200")).toBe(false);
  });

  it("移除后恢复未拉黑状态", async () => {
    await addBlockedAccount({
      accountKey: "uid:100",
      uid: "100",
      aiProbability: 85,
      blockedAtMs: 1,
    });
    await removeBlockedAccount("uid:100");
    expect(await isBlocked("uid:100")).toBe(false);
    expect(await getBlockedAccounts()).toEqual([]);
  });

  it("存储键未初始化时返回空列表", async () => {
    expect(await getBlockedAccounts()).toEqual([]);
    expect(storedValues[BLOCKED_STORAGE_KEY]).toBeUndefined();
  });
});

describe("CSRF 令牌读取", () => {
  beforeEach(() => {
    installChromeStub();
  });

  // 说明：bili_jct 是 HttpOnly，document.cookie 读不到。旧实现因此在取令牌
  // 阶段就 return，请求根本没发出，用户看到「点击无反应」。现实现改为
  // chrome.cookies.get。
  // 下面直接测生产函数 readBilibiliCsrf，并验证三种失败原因被区分开——
  // 旧实现把它们都坍缩成空串，界面只能提示「请刷新页面」。
  // 源码层面不再出现 document.cookie 调用由 typecheck 与下方行为测试保证。

  it("chrome.cookies 取到值时 trim 后返回", async () => {
    vi.stubGlobal("chrome", {
      permissions: {
        contains: async () => true,
        request: async () => true,
      },
      cookies: {
        // 按实现的调用参数返回，同时钉住读取 URL 必须是 api 子域
        // （bili_jct 的 domain 是 .bilibili.com，换成 www 会读不到）。
        get: async (query: { url: string; name: string }) => {
          expect(query.url).toBe("https://api.bilibili.com/");
          expect(query.name).toBe("bili_jct");
          return { value: "  abc123token  " };
        },
      },
    });
    const result = await readBilibiliCsrf();
    expect(result).toEqual({ status: "ok", csrf: "abc123token" });
  });

  it("未授予 cookies 权限时返回 no-permission", async () => {
    vi.stubGlobal("chrome", {
      permissions: {
        contains: async () => false,
        request: async () => false,
      },
      cookies: { get: async () => { throw new Error("不该被调用"); } },
    });
    expect(await readBilibiliCsrf()).toEqual({ status: "no-permission" });
  });

  it("cookie 不存在或为空时返回 no-cookie", async () => {
    vi.stubGlobal("chrome", {
      permissions: { contains: async () => true, request: async () => true },
      cookies: { get: async () => null },
    });
    expect(await readBilibiliCsrf()).toEqual({ status: "no-cookie" });

    vi.stubGlobal("chrome", {
      permissions: { contains: async () => true, request: async () => true },
      cookies: { get: async () => ({ value: "   " }) },
    });
    expect(await readBilibiliCsrf()).toEqual({ status: "no-cookie" });
  });

  it("失败原因翻译成可操作的中文说明", () => {
    const noPermission = describeCsrfFailure("no-permission");
    const noCookie = describeCsrfFailure("no-cookie");
    // 未授权要指向设置页授权，未登录要指向登录——两者不能混为一谈。
    expect(noPermission).toContain("拉黑授权");
    expect(noCookie).toContain("登录");
    expect(noPermission).not.toBe(noCookie);
  });
});

describe("点击外部关闭面板", () => {
  function cardLocal(): ExtractedCard {
    const cardElement = document.createElement("div");
    document.body.append(cardElement);
    return {
      cardKey: "test:BV1:uid:123",
      accountKey: "uid:123",
      uid: "123",
      uidSource: "card",
      displayName: "测试账号",
      profileUrl: "https://space.bilibili.com/123",
      video: {
        videoKey: "BV1",
        bvid: "BV1",
        title: "标题",
        videoUrl: "https://www.bilibili.com/video/BV1",
      },
      missingFields: [],
      source: { pageKind: "home", adapterId: "test", adapterVersion: 1 },
      observedAtMs: 1,
      mount: { cardElement },
    } as unknown as ExtractedCard;
  }

  function analysisLocal(): AccountAnalysis {
    return {
      accountKey: "uid:123",
      uid: "123",
      displayName: "测试账号",
      disposition: "none",
      observedVideos: 6,
      hasBio: true,
      review: {
        kind: "triggered",
        triggers: [
          { signal: "repost-disclaimer", detail: "简介含侵权免责声明" },
        ],
      },

    } as AccountAnalysis;
  }

  function openPanelOf(target: ExtractedCard): HTMLElement {
    renderBadge(target, analysisLocal(), DEFAULT_SETTINGS, async () => undefined);
    const host = target.mount.cardElement.querySelector<HTMLElement>("[class*='badge-host']")!;
    host.shadowRoot!.querySelector<HTMLButtonElement>(".badge")!.click();
    return host;
  }

  function visiblePanel(): HTMLDivElement | null {
    return (
      document
        .getElementById("kcf-panel-float")
        ?.shadowRoot?.querySelector<HTMLDivElement>(".panel") ?? null
    );
  }

  it("打开第二个面板时自动关闭第一个", () => {
    const a = openPanelOf(cardLocal());
    const b = openPanelOf(cardLocal());
    const panelA = a.shadowRoot!.querySelector<HTMLDivElement>(".panel")!;
    const panelB = visiblePanel();
    // 打开 B 时 A 应被自动关闭（同时只保留一个面板）。
    expect(panelA.hidden).toBe(true);
    expect(panelB?.hidden).toBe(false);
    removeAllBadges();
  });

  it("点击页面其他位置关闭所有已展开的面板", () => {
    const a = openPanelOf(cardLocal());
    const b = openPanelOf(cardLocal());
    // 点击 body（插件 UI 之外）
    document.body.dispatchEvent(
      new MouseEvent("click", { bubbles: true, composed: true }),
    );
    const panelA = a.shadowRoot!.querySelector<HTMLDivElement>(".panel")!;
    const panelB = b.shadowRoot!.querySelector<HTMLDivElement>(".panel")!;
    expect(panelA.hidden).toBe(true);
    expect(panelB.hidden).toBe(true);
    removeAllBadges();
  });

  it("点击面板内部不会关闭面板", () => {
    openPanelOf(cardLocal());
    const panelA = visiblePanel();
    expect(panelA).not.toBeNull();
    panelA!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, composed: true }),
    );
    expect(panelA!.hidden).toBe(false);
    removeAllBadges();
  });
});

describe("关系属性查询", () => {
  it("attribute 128 判为已拉黑，0 判为未拉黑（实测编码）", async () => {
    expect(isBlockedAttribute(128)).toBe(true);
    expect(isBlockedAttribute(0)).toBe(false);
    // 位判定：其他关系位（如关注 2/4/6）不影响拉黑判断。
    expect(isBlockedAttribute(130)).toBe(true);
    expect(isBlockedAttribute(6)).toBe(false);
  });

  it("fetchRelationAttribute 解析 data.attribute", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 0, data: { attribute: 128 } }), { status: 200 }),
    );
    expect(await fetchRelationAttribute("123", fetchImpl as unknown as typeof fetch)).toBe(128);
  });

  it("未登录（code -101）或请求异常时返回 null", async () => {
    const notLoggedIn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: -101, message: "账号未登录" }), { status: 200 }),
    );
    expect(await fetchRelationAttribute("123", notLoggedIn as unknown as typeof fetch)).toBeNull();
    const networkFail = vi.fn().mockRejectedValue(new Error("网络失败"));
    expect(await fetchRelationAttribute("123", networkFail as unknown as typeof fetch)).toBeNull();
  });
});

describe("面板拉黑按钮与二次确认", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  const card = (): ExtractedCard => {
    const cardElement = document.createElement("div");
    document.body.append(cardElement);
    return {
      cardKey: "test:BV1:uid:123",
      accountKey: "uid:123",
      uid: "123",
      uidSource: "card",
      displayName: "测试账号",
      profileUrl: "https://space.bilibili.com/123",
      video: {
        videoKey: "BV1",
        bvid: "BV1",
        title: "标题",
        videoUrl: "https://www.bilibili.com/video/BV1",
      },
      missingFields: [],
      source: { pageKind: "home", adapterId: "test", adapterVersion: 1 },
      observedAtMs: 1,
      mount: { cardElement },
    } as unknown as ExtractedCard;
  };

  const analysis = (): AccountAnalysis =>
    ({
      accountKey: "uid:123",
      uid: "123",
      displayName: "测试账号",
      disposition: "none",
      observedVideos: 6,
      hasBio: true,
      review: {
        kind: "triggered",
        triggers: [
          { signal: "repost-disclaimer", detail: "简介含侵权免责声明" },
        ],
      },

    }) as AccountAnalysis;

  it("出现拉黑按钮，点击后先内联确认（不直接调用）", async () => {
    const target = card();
    const actions: string[] = [];
    renderBadge(
      target,
      analysis(),
      DEFAULT_SETTINGS,
      async () => undefined,
      undefined,
      undefined,
      async (action) => {
        actions.push(action);
      },
    );
    const host = target.mount.cardElement.querySelector<HTMLElement>(".kcf-badge-host")!;
    const badge = host.shadowRoot!.querySelector<HTMLButtonElement>(".badge")!;
    badge.click();

    const panelRoot = document.getElementById("kcf-panel-float")!.shadowRoot!;
    const blockButton = [...panelRoot.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "拉黑",
    )!;
    expect(blockButton).toBeDefined();

    // 第一次点击只展开确认区，不触发平台动作。
    blockButton.click();
    await Promise.resolve();
    const confirm = panelRoot.querySelector(".block-confirm")!;
    expect(confirm.textContent).toContain("确认拉黑");
    expect(actions).toEqual([]);

    // 确认后才真正调用，且动作类型为 block。
    const confirmButton = [...confirm.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "确认拉黑",
    )!;
    confirmButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(actions).toEqual(["block"]);
    // 调用后面板回到按钮态（确认区消失）。
    expect(panelRoot.querySelector(".block-confirm")).toBeNull();
  });

  it("不提供 onBlock 时不显示拉黑按钮", () => {
    const target = card();
    renderBadge(target, analysis(), DEFAULT_SETTINGS, async () => undefined);
    const host = target.mount.cardElement.querySelector<HTMLElement>(".kcf-badge-host")!;
    host.shadowRoot!.querySelector<HTMLButtonElement>(".badge")!.click();
    const hasBlock = [...host.shadowRoot!.querySelectorAll("button")].some(
      (button) => button.textContent === "拉黑",
    );
    expect(hasBlock).toBe(false);
    removeAllBadges();
  });

  it("面板打开时核对真实状态：本地过期则按钮从「取消拉黑」修正为「拉黑」", async () => {
    // 模拟本地记录：该账号曾被插件拉黑。
    refreshBlockedAccounts(["uid:123"]);
    const target = card();
    const actions: string[] = [];
    renderBadge(
      target,
      analysis(),
      DEFAULT_SETTINGS,
      async () => undefined,
      undefined,
      undefined,
      async (action) => {
        actions.push(action);
      },
      // 核对结果：B 站侧已解除拉黑（本地记录过期）。
      async () => false,
    );
    const host = target.mount.cardElement.querySelector<HTMLElement>(".kcf-badge-host")!;
    const badge = host.shadowRoot!.querySelector<HTMLButtonElement>(".badge")!;
    badge.click();

    const blockButton = () =>
      [...document.getElementById("kcf-panel-float")!.shadowRoot!.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "取消拉黑" || button.textContent === "拉黑",
      )!;
    // 本地记录认为已拉黑 → 初始显示「取消拉黑」。
    expect(blockButton().textContent).toBe("取消拉黑");
    // 核对完成后修正为「拉黑」。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(blockButton().textContent).toBe("拉黑");
    removeAllBadges();
  });

  it("核对确认仍在拉黑时按钮保持「取消拉黑」", async () => {
    const target = card();
    renderBadge(
      target,
      analysis(),
      DEFAULT_SETTINGS,
      async () => undefined,
      undefined,
      undefined,
      async () => undefined,
      // 核对结果：B 站侧确实已拉黑。
      async () => true,
    );
    const host = target.mount.cardElement.querySelector<HTMLElement>(".kcf-badge-host")!;
    host.shadowRoot!.querySelector<HTMLButtonElement>(".badge")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const blockButton = [...document.getElementById("kcf-panel-float")!.shadowRoot!.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "取消拉黑",
    );
    expect(blockButton).toBeDefined();
    removeAllBadges();
  });
});
