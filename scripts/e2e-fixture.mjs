/**
 * 浏览器夹具 E2E：真实扩展 + 确定性 DOM。
 *
 * 原理：headless Edge 加载 dist/ 扩展后，用 CDP Fetch 域拦截 B 站三个域名的
 * 文档请求，以本地脱敏夹具响应替代真实页面。浏览器认为自己就在 B 站上，
 * content script 正常注入，从而在**不联网、不登录、不受真实页面改版影响**
 * 的情况下验证：
 *   manifest 注入 → 适配器解析 → IndexedDB 入库 → 标签渲染。
 *
 * 它测的是 jsdom 测不了、真 B 站又测不稳的 MV3 机制。
 * 单元测试与真机人工清单都不在这里。
 *
 * 断言刻意选**重构不变式**：卡片数、徽章宿主数、以及 IndexedDB 里实际落库的
 * 账号/投稿条数。后两者证明观察真的写进了库，而不只是 DOM 上挂了宿主。
 * 「哪些账号该被打上触发角标」这类语义断言随功能演进而变，
 * 放在 tests/ 的单元测试里，不放在这里。
 *
 * 用法：先 npm run build，再启动带扩展的 Edge（CDP 端口），然后：
 *   node scripts/e2e-fixture.mjs 9224
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.argv[2] ?? "9222");
const base = `http://127.0.0.1:${port}`;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 本扩展在 manifest 里的名字，用来在多个扩展的 isolated world 中认出自己。 */
const extensionName = JSON.parse(
  readFileSync(join(projectRoot, "dist", "manifest.json"), "utf8"),
).name;

function readFixture(name) {
  return readFileSync(
    join(projectRoot, "e2e", "fixtures", `${name}.html`),
    "utf8",
  );
}

/**
 * 夹具清单。
 *
 * expectCards：页面上 .bili-video-card 总数。解析不出 UID 的无作者卡也会挂上
 *   一个灰色徽章宿主，因此宿主数恒等于卡片数——「无作者卡的灰色徽章」
 *   由 tests/badge-renderer.test.ts 覆盖，这里不断言它的文案。
 * expectUids：本夹具应当落库的账号 UID。三个夹具的 UID 互不重叠，
 *   因此断言「库里已有这些 UID」对执行顺序与重复运行都稳定
 *   （upsert 幂等，再跑一次条数不变）。
 * expectVideos：本夹具应贡献的投稿观察条数，按累计值断言。
 * expectTriggered：哪些 UID 的徽章应含哪个文本片段（触发器端到端断言）。
 *   空间页的 UID 来自页面地址、卡片里没有作者链接，因此不参与此断言。
 */
const FIXTURES = [
  {
    name: "bilibili-home",
    url: "https://www.bilibili.com/",
    expectCards: 12,
    expectUids: [
      "100200300",
      "100200301",
      "100200302",
      "100200303",
      "100200304",
    ],
    // 12 张卡里有 1 张无作者卡，其投稿无法归属账号，不入库。
    expectVideos: 11,
    expectTriggered: [
      // 标题兜售成套资源。
      { uid: "100200301", marker: "值得复核" },
      // 同一个 BV 由两个不同账号发布。
      { uid: "100200302", marker: "值得复核" },
      { uid: "100200303", marker: "值得复核" },
      // 24 小时内 5 条。
      { uid: "100200304", marker: "值得复核" },
      // 普通账号：无任何本地信号，中性态而非「低风险」。
      { uid: "100200300", marker: "无判定" },
    ],
  },
  {
    name: "bilibili-search",
    url: "https://search.bilibili.com/all?keyword=%E6%A0%B8%E7%94%B0",
    expectCards: 5,
    expectUids: ["200100100", "200100101", "200100102"],
    expectVideos: 15,
    expectTriggered: [
      // 「共120集全 中英字幕」命中成套资源兜售。
      { uid: "200100101", marker: "值得复核" },
      { uid: "200100100", marker: "无判定" },
    ],
  },
  {
    name: "bilibili-space",
    url: "https://space.bilibili.com/100200305/video",
    expectCards: 6,
    // 空间页的 UID 来自页面地址，6 张卡同属一个账号。
    expectUids: ["100200305"],
    expectVideos: 21,
    // 卡片里没有作者链接，徽章无法按 UID 归属，故不做触发器断言；
    // 该夹具覆盖的是空间页适配器解析、简介读取与入库。
  },
];

/** 需要拦截的文档请求域名；子资源一律失败，保持确定性、不联网。 */
const INTERCEPT_PATTERNS = [
  { urlPattern: "https://www.bilibili.com/*" },
  { urlPattern: "https://search.bilibili.com/*" },
  { urlPattern: "https://space.bilibili.com/*" },
];

/** 建立浏览器级 CDP 连接，非响应消息全部堆进 events 供后续按需消费。 */
function connect(wsUrl) {
  return new Promise((resolveConnect, rejectConnect) => {
    const socket = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const events = [];
    socket.addEventListener("open", () => {
      resolveConnect({
        call(method, params = {}, sessionId) {
          const id = nextId++;
          return new Promise((resolveCall, rejectCall) => {
            pending.set(id, { resolveCall, rejectCall });
            socket.send(
              JSON.stringify(
                sessionId === undefined
                  ? { id, method, params }
                  : { id, method, params, sessionId },
              ),
            );
          });
        },
        events,
        close() {
          socket.close();
        },
      });
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error !== undefined) {
          entry.rejectCall(new Error(message.error.message));
        } else {
          entry.resolveCall(message.result);
        }
        return;
      }
      if (message.method !== undefined) {
        events.push(message);
      }
    });
    socket.addEventListener("error", () =>
      rejectConnect(new Error("WebSocket 连接失败。")),
    );
  });
}

async function evaluateOn(session, expression) {
  const { result, exceptionDetails } = await session.call("Runtime.evaluate", {
    expression,
    // awaitPromise 必须开：读 IndexedDB 的表达式返回的是 Promise，
    // 不开的话 CDP 回一个无法序列化的对象，拿到的是 {} 而不是数据。
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails !== undefined) {
    throw new Error(
      exceptionDetails.exception?.description ?? "页面脚本执行失败。",
    );
  }
  return result.value;
}

/**
 * 在扩展自己的页面上执行表达式（与 Service Worker 同源，
 * 因此能读到扩展的 IndexedDB）。
 */
async function evaluateInExtensionPage(browser, extensionId, expression) {
  const { targetId } = await browser.call("Target.createTarget", {
    url: `chrome-extension://${extensionId}/popup.html`,
  });
  const { sessionId } = await browser.call("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const session = { call: (m, p) => browser.call(m, p, sessionId) };
  try {
    await session.call("Runtime.enable");
    // 等页面真正导航到扩展源：createTarget 之后有一小段仍是初始文档，
    // 在错的源上打开 IndexedDB 会静默建出一个空库，读出来的就是 {}。
    let reached = false;
    for (let attempt = 0; attempt < 40 && !reached; attempt += 1) {
      await delay(150);
      const href = await evaluateOn(session, "location.href");
      reached =
        typeof href === "string" &&
        href.startsWith(`chrome-extension://${extensionId}/`);
    }
    if (!reached) {
      return null;
    }
    return await evaluateOn(session, expression);
  } finally {
    await browser.call("Target.closeTarget", { targetId });
  }
}

/**
 * 读观察库：各对象存储的记录数 + 已落库的账号 UID 清单。
 * 打不开库时返回 null；返回的 UID 已排序，断言时可直接比对。
 */
/**
 * 读观察库：各对象存储的记录数 + 已落库的账号 UID 清单。
 * 打不开库时返回 null；返回的 UID 已排序，断言时可直接比对。
 */
const COUNT_STORES = `(() => new Promise((resolveCount) => {
  const request = indexedDB.open("kcf-detector");
  request.onerror = () => resolveCount(null);
  request.onsuccess = () => {
    const database = request.result;
    const names = [...database.objectStoreNames];
    const collectOne = (name) =>
      new Promise((resolveOne) => {
        const store = database.transaction(name, "readonly").objectStore(name);
        const keyRequest = store.getAllKeys();
        keyRequest.onsuccess = () => {
          const countRequest = store.count();
          countRequest.onsuccess = () =>
            resolveOne({
              count: countRequest.result,
              keys: keyRequest.result.map((key) => String(key)),
            });
          countRequest.onerror = () => resolveOne({ count: -1, keys: [] });
        };
        keyRequest.onerror = () => resolveOne({ count: -1, keys: [] });
      });
    (async () => {
      const counts = {};
      const accounts = [];
      for (const name of names) {
        const { count, keys } = await collectOne(name);
        counts[name] = count;
        if (name === "account_profiles") {
          accounts.push(...keys);
        }
      }
      resolveCount({
        counts,
        // account_profiles 的键就是 accountKey（形如 uid:12345），
        // 剥掉前缀剩 UID，正好与夹具的 expectUids 对齐。
        accounts: accounts
          .map((key) => key.replace(/^uid:/u, ""))
          .sort(),
      });
    })();
  };
}))()`;

async function main() {
  const results = [];
  const record = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };

  const version = await (await fetch(`${base}/json/version`)).json();
  const browser = await connect(version.webSocketDebuggerUrl);
  /** 扩展 isolated world 出现过的 origin，用来发现扩展 ID。 */
  const extensionOrigins = new Set();

  for (const fixture of FIXTURES) {
    const fixtureHtml = readFixture(fixture.name);
    const { targetId } = await browser.call("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await browser.call("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const session = { call: (m, p) => browser.call(m, p, sessionId) };
    await session.call("Page.enable");
    await session.call("Runtime.enable");
    await session.call("Fetch.enable", { patterns: INTERCEPT_PATTERNS });

    // 拦截策略：文档请求以夹具响应；其余子资源一律失败（保持确定性、不联网）。
    let draining = true;
    const drainEvents = (async () => {
      while (draining) {
        const paused = browser.events.find(
          (item) => item.method === "Fetch.requestPaused" && !item.__handled,
        );
        if (paused === undefined) {
          await delay(50);
          continue;
        }
        paused.__handled = true;
        const { requestId, resourceType } = paused.params;
        if (resourceType === "Document") {
          await session.call("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [
              { name: "content-type", value: "text/html; charset=utf-8" },
            ],
            body: Buffer.from(fixtureHtml, "utf8").toString("base64"),
          });
        } else {
          await session.call("Fetch.failRequest", {
            requestId,
            errorReason: "Aborted",
          });
        }
      }
    })();

    await session.call("Page.navigate", { url: fixture.url });
    await delay(8_000);
    draining = false;
    await drainEvents;

    const domState = await evaluateOn(
      session,
      `(() => ({
        cards: document.querySelectorAll(".bili-video-card").length,
        hosts: document.querySelectorAll(".kcf-badge-host").length,
        badges: [...document.querySelectorAll(".kcf-badge-host")]
          .map((host) => host.shadowRoot?.querySelector(".badge")?.textContent ?? null),
      }))()`,
    );
    record(
      `[${fixture.name}] 卡片与徽章宿主数量`,
      domState.cards === fixture.expectCards &&
        domState.hosts === fixture.expectCards,
      `卡片 ${domState.cards}/${fixture.expectCards}，宿主 ${domState.hosts}/${fixture.expectCards}`,
    );
    record(
      `[${fixture.name}] 每个徽章都有文本`,
      domState.badges.length === fixture.expectCards &&
        domState.badges.every(
          (text) => typeof text === "string" && text.length > 0,
        ),
      JSON.stringify(domState.badges),
    );

    // 触发器断言：本地命中的账号显示「值得复核」，未命中的显示中性态。
    // 徽章文本按账号 UID 归属，因此这里是端到端验证
    // 「适配器解析 → 入库 → 触发器 → 徽章」整条链路。
    if (fixture.expectTriggered !== undefined) {
      const badgeByUid = await evaluateOn(
        session,
        `(() => {
          const map = {};
          for (const card of document.querySelectorAll(".bili-video-card")) {
            // 作者链接可能在卡片内，也可能在所属搜索模块里（搜索页结构），
            // 与适配器自己的 allowSearchModuleFallback 兜底同一条路径。
            const scope = card.closest(".video-card-content") ?? card;
            const owner = scope.querySelector('a[href*="space.bilibili.com/"]');
            const host = card.querySelector(".kcf-badge-host");
            if (owner === null || host === null) {
              continue;
            }
            const uid = /space\\.bilibili\\.com\\/(\\d+)/.exec(owner.getAttribute("href") ?? "")?.[1];
            const text = host.shadowRoot?.querySelector(".badge")?.textContent;
            if (uid !== undefined && text !== undefined) {
              map[uid] = text;
            }
          }
          return map;
        })()`,
      );
      const mismatched = fixture.expectTriggered.filter(
        ({ uid, marker }) => !(badgeByUid?.[uid] ?? "").includes(marker),
      );
      record(
        `[${fixture.name}] 触发器命中与未命中分别渲染`,
        mismatched.length === 0,
        mismatched.length === 0
          ? `${fixture.expectTriggered.length} 个账号徽章符合预期`
          : `不符：${mismatched
              .map((item) => `${item.uid}→${badgeByUid?.[item.uid]}`)
              .join(", ")}`,
      );
    }

    // 扩展 ID：从页面 isolated world 的 executionContextCreated 里拿。
    // 不能依赖 service_worker target——MV3 空闲约 30 秒就回收它。
    // 一个页面上可能有多个扩展的 isolated world，因此按 manifest 里的扩展名
    // 精确匹配；取错 origin 会静默打开一个空库，读出来是 {} 而不是报错。
    for (const event of browser.events) {
      const context = event.params?.context;
      const origin = context?.origin;
      if (
        typeof origin === "string" &&
        origin.startsWith("chrome-extension://") &&
        context?.name === extensionName
      ) {
        extensionOrigins.add(origin);
      }
    }
    const extensionId = [...extensionOrigins][0]
      ?.replace("chrome-extension://", "")
      .replace(/\/$/, "");

    if (extensionId === undefined) {
      record(
        `[${fixture.name}] 观察已落入 IndexedDB`,
        false,
        "未发现本扩展的 isolated world",
      );
    } else {
      const stored = await evaluateInExtensionPage(
        browser,
        extensionId,
        COUNT_STORES,
      );
      const missingUids = fixture.expectUids.filter(
        (uid) => !(stored?.accounts ?? []).includes(uid),
      );
      // 投稿条数用「不少于」而不是「等于」：upsert 幂等，重跑不会增加条数，
      // 但换一个已经跑过的 profile 时起点不是 0，等于号会假失败。
      const videos = stored?.counts?.video_observations ?? -1;
      record(
        `[${fixture.name}] 观察已落入 IndexedDB`,
        stored !== null &&
          missingUids.length === 0 &&
          videos >= fixture.expectVideos,
        stored === null
          ? "无法打开观察库"
          : `账号 UID ${missingUids.length === 0 ? "齐全" : `缺 ${missingUids.join(",")}`}，投稿 ${videos}（至少 ${fixture.expectVideos}）`,
      );
    }

    await browser.call("Target.closeTarget", { targetId });
  }

  browser.close();

  const failed = results.filter((ok) => !ok).length;
  console.log(
    failed === 0
      ? `夹具 E2E：${results.length} 项全部通过`
      : `夹具 E2E：${failed}/${results.length} 项失败`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("E2E 执行失败：", error instanceof Error ? error.message : error);
  process.exit(1);
});
