/**
 * B 站视频卡片扫描器工厂：三种页面（首页/搜索/空间）共用同一套
 * 选择器候选与提取流程，仅通过配置开关区分身份兜底策略。
 */
import type {
  AdapterDiagnostic,
  AdapterScanResult,
  ExtractedCard,
  PageAdapter,
} from "../contract";
import type { AccountKey, ObservationSource, PageKind } from "../../domain/types";
import {
  compactText,
  parseBilibiliProfileUrl,
  parseBilibiliVideoUrl,
  parsePublishedAt,
  parseSpaceUidFromPage,
} from "./parsers";

/** 视频卡片根元素类名（B 站首页/搜索/空间通用）。 */
const CARD_SELECTOR = ".bili-video-card";
/** 视频链接锚点：必须包含 /video/BV 才算有效。 */
const VIDEO_LINK_SELECTOR = 'a[href*="/video/BV"]';
/**
 * 作者链接候选（按优先级依次尝试）：
 * 专用作者类名 → 任意空间链接 → https 开头的空间链接。
 */
const OWNER_LINK_SELECTORS = [
  '.bili-video-card__info--owner[href*="space.bilibili.com"]',
  'a[href*="//space.bilibili.com/"]',
  'a[href^="https://space.bilibili.com/"]',
];
/** 标题候选：优先取 title 属性（完整标题），退回文本内容。 */
const TITLE_SELECTORS = [
  ".bili-video-card__info--tit[title]",
  ".bili-video-card__title[title]",
  'a[title][href*="/video/BV"]',
];
/** 发布时间候选。 */
const PUBLISHED_SELECTORS = [
  ".bili-video-card__info--date",
  ".bili-video-card__subtitle",
];
/** 统计信息候选（播放、弹幕原文，只入库）。 */
const METRIC_SELECTORS = [
  ".bili-video-card__stats--text",
  ".bili-cover-card__stat span",
];

/** 卡片适配器配置：除基础信息外，可按页面种类打开身份兜底。 */
export interface CardScanConfig {
  id: string;
  version: number;
  pageKind: PageKind;
  matches(url: URL): boolean;
  /** 允许在搜索模块容器内查找作者链接（搜索页卡片结构特殊）。 */
  allowSearchModuleFallback?: boolean;
  /** 允许直接信任空间页地址中的 UID（UP 主主页）。 */
  allowSpacePageFallback?: boolean;
}

/**
 * 创建一个基于卡片选择器的页面适配器。
 * @param config 页面配置
 */
export function createCardAdapter(config: CardScanConfig): PageAdapter {
  return {
    id: config.id,
    version: config.version,
    pageKind: config.pageKind,
    matches(url) {
      return config.matches(url);
    },
    scan(document, url, nowMs, candidateCards) {
      return scanCards(document, url, nowMs, config, candidateCards);
    },
  };
}

/**
 * 增量候选里经常是推荐流外壳 `.bili-feed-card`，真正的视频卡在里面。
 * 外壳本身不是 `.bili-video-card`，直接丢掉会让这一轮变成 0 张卡。
 */
function collectCandidateCards(candidateCards: Iterable<Element>): HTMLElement[] {
  const collected: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  const add = (element: HTMLElement): void => {
    if (seen.has(element)) {
      return;
    }
    seen.add(element);
    collected.push(element);
  };
  for (const element of candidateCards) {
    if (!(element instanceof HTMLElement)) {
      continue;
    }
    if (element.matches(CARD_SELECTOR)) {
      add(element);
      continue;
    }
    for (const card of element.querySelectorAll<HTMLElement>(CARD_SELECTOR)) {
      add(card);
    }
  }
  return collected;
}

/**
 * 扫描页面上的视频卡片。
 *
 * 健康度判定：无卡片，或超过半数卡片解析不出稳定账号身份时判为
 * degraded。注意这是**本轮扫描范围**内的诊断信号：增量扫描只拿到新增
 * 卡片，一张失败卡片就会让 1/1 变成 100% 失败。页面级健康度由
 * content/page-stats 按整页已见卡片计算；已解析出身份的卡片不会因为
 * 同批存在失败卡片而被丢弃。
 *
 * @param candidateCards 增量扫描时的候选卡片；省略则全量查询。
 * 长列表页面上每次只处理新增卡片，避免重复遍历数百个节点。
 */
function scanCards(
  document: Document,
  url: URL,
  nowMs: number,
  config: CardScanConfig,
  candidateCards?: Iterable<Element>,
): AdapterScanResult {
  const cardElements =
    candidateCards === undefined
      ? Array.from(document.querySelectorAll<HTMLElement>(CARD_SELECTOR))
      : collectCandidateCards(candidateCards);
  const diagnostics: AdapterDiagnostic[] = [
    {
      selectorKey: "video-card",
      status: cardElements.length > 0 ? "matched" : "missing",
      count: cardElements.length,
    },
  ];
  const cards: ExtractedCard[] = [];
  let unresolvedIdentityCount = 0;

  for (const [index, cardElement] of cardElements.entries()) {
    const extracted = extractCard(
      document,
      cardElement,
      url,
      nowMs,
      config,
      index,
    );
    if (extracted === undefined) {
      continue;
    }
    // 身份解析失败的卡片仍进入结果（供渲染「未识别账号」说明），但计数。
    if (extracted.accountKey === undefined) {
      unresolvedIdentityCount += 1;
    }
    cards.push(extracted);
  }

  diagnostics.push({
    selectorKey: "stable-account-identity",
    status:
      cards.length === 0
        ? "missing"
        : unresolvedIdentityCount === 0
          ? "matched"
          : "fallback",
    count: cards.length - unresolvedIdentityCount,
  });

  const health =
    cards.length === 0
      ? "degraded"
      : unresolvedIdentityCount / cards.length > 0.5
        ? "degraded"
        : "healthy";

  return {
    adapterId: config.id,
    adapterVersion: config.version,
    pageKind: config.pageKind,
    health,
    cards,
    diagnostics,
  };
}

/**
 * 提取单张卡片。
 * @returns 结构化卡片；缺少视频链接或标题时返回 undefined（无法成卡）
 */
function extractCard(
  document: Document,
  cardElement: HTMLElement,
  pageUrl: URL,
  nowMs: number,
  config: CardScanConfig,
  index: number,
): ExtractedCard | undefined {
  const videoAnchor = findVideoAnchor(cardElement, pageUrl.href);
  if (videoAnchor === undefined) {
    return undefined;
  }
  const parsedVideo = parseBilibiliVideoUrl(
    videoAnchor.getAttribute("href") ?? videoAnchor.href,
    pageUrl.href,
  );
  if (parsedVideo === undefined) {
    return undefined;
  }

  // 作者身份解析：卡片内链接 →（可选）搜索模块 →（可选）空间页地址。
  const ownerResolution = resolveOwner(
    document,
    cardElement,
    pageUrl,
    config,
  );
  // 标题多级兜底：标题元素 title 属性 → 锚点 title → 锚点文本 → 封面 alt。
  const rawTitle =
    readTextBySelectors(cardElement, TITLE_SELECTORS, "title") ??
    compactText(videoAnchor.getAttribute("title")) ??
    compactText(videoAnchor.textContent) ??
    readCoverAlt(cardElement);
  if (rawTitle === undefined) {
    return undefined;
  }
  // 标题截断到协议上限，防止异常长文本被消息校验拒绝。
  const title = rawTitle.slice(0, 500);

  const publishedText = readTextBySelectors(
    cardElement,
    PUBLISHED_SELECTORS,
  )?.slice(0, 100);
  const publishedAtMs = parsePublishedAt(publishedText, nowMs);
  const image = cardElement.querySelector<HTMLImageElement>("img");
  const coverUrl = normalizeHttpUrl(
    image?.currentSrc || image?.src || undefined,
  );
  const metricsRaw = METRIC_SELECTORS.flatMap((selector) =>
    Array.from(cardElement.querySelectorAll<HTMLElement>(selector))
      .map((element) => compactText(element.textContent))
      .filter((value): value is string => value !== undefined),
  ).slice(0, 12).map((value) => value.slice(0, 100));
  const source: ObservationSource = {
    pageKind: config.pageKind,
    adapterId: config.id,
    adapterVersion: config.version,
  };
  // 记录缺失字段，供诊断与低样本提示。
  const missingFields: string[] = [];
  if (ownerResolution.uid === undefined) missingFields.push("uid");
  if (ownerResolution.displayName === undefined) missingFields.push("displayName");
  if (publishedText === undefined) missingFields.push("publishedText");
  if (coverUrl === undefined) missingFields.push("coverUrl");

  // 只有解析出稳定 UID 才生成账号主键；否则该卡片不落库。
  const accountKey =
    ownerResolution.uid === undefined
      ? undefined
      : (`uid:${ownerResolution.uid}` as AccountKey);

  return {
    cardKey: `${config.id}:${parsedVideo.bvid}:${accountKey ?? `unresolved-${index}`}`,
    accountKey,
    uid: ownerResolution.uid,
    uidSource: ownerResolution.source,
    displayName: ownerResolution.displayName,
    profileUrl: ownerResolution.profileUrl,
    profileBio: ownerResolution.profileBio,
    video: {
      videoKey: parsedVideo.bvid,
      bvid: parsedVideo.bvid,
      title,
      videoUrl: parsedVideo.url.href,
      ...(coverUrl === undefined ? {} : { coverUrl }),
      ...(publishedText === undefined ? {} : { publishedText }),
      ...(publishedAtMs === undefined ? {} : { publishedAtMs }),
      metricsRaw: [...new Set(metricsRaw)],
      source,
      observedAtMs: nowMs,
    },
    missingFields,
    source,
    mount: {
      cardElement,
      anchorElement: videoAnchor,
    },
  };
}

/**
 * 查找卡片内第一个能解析出 BVID 的视频锚点。
 * @returns 有效的视频链接锚点；没有则 undefined
 */
function findVideoAnchor(
  cardElement: HTMLElement,
  baseUrl: string,
): HTMLAnchorElement | undefined {
  const anchors = Array.from(
    cardElement.querySelectorAll<HTMLAnchorElement>(VIDEO_LINK_SELECTOR),
  );
  return anchors.find(
    (anchor) =>
      parseBilibiliVideoUrl(
        anchor.getAttribute("href") ?? anchor.href,
        baseUrl,
      ) !== undefined,
  );
}

/**
 * 解析卡片作者身份。
 *
 * 兜底顺序：卡片内作者链接 → 搜索模块容器内链接 → 空间页地址。
 * 首页适配器不开启任何兜底：宁缺毋滥，避免把页面其他空间链接
 * （如顶部登录用户）误绑到视频作者上。
 */
function resolveOwner(
  document: Document,
  cardElement: HTMLElement,
  pageUrl: URL,
  config: CardScanConfig,
): {
  uid?: string;
  source: ExtractedCard["uidSource"];
  displayName?: string;
  profileUrl?: string;
  profileBio?: string;
} {
  const directOwner = findProfileAnchor(cardElement, pageUrl.href);
  if (directOwner !== undefined) {
    return ownerFromAnchor(directOwner, pageUrl.href, "card");
  }

  if (config.allowSearchModuleFallback === true) {
    // 搜索页卡片本身可能不含作者链接，向上找所属搜索模块。
    const module = cardElement.closest<HTMLElement>(".video-card-content");
    const moduleOwner =
      module === null ? undefined : findProfileAnchor(module, pageUrl.href);
    if (moduleOwner !== undefined) {
      return ownerFromAnchor(moduleOwner, pageUrl.href, "search-module");
    }
  }

  if (config.allowSpacePageFallback === true) {
    // UP 主主页：页面地址即身份，同时读取昵称与签名。
    const uid = parseSpaceUidFromPage(pageUrl);
    if (uid !== undefined) {
      const displayName =
        readTextBySelectors(document, [".nickname", "#h-name"], "title") ??
        compactText(document.querySelector(".nickname")?.textContent);
      const profileBio = readTextBySelectors(document, [
        ".sign.header-sign",
        ".h-sign",
      ]);
      return {
        uid,
        source: "space-url",
        profileUrl: `https://space.bilibili.com/${uid}`,
        ...(displayName === undefined
          ? {}
          : { displayName: displayName.slice(0, 200) }),
        ...(profileBio === undefined
          ? {}
          : { profileBio: profileBio.slice(0, 2_000) }),
      };
    }
  }

  return { source: "missing" };
}

/** 按候选选择器顺序查找第一个能解析出 UID 的空间链接。 */
function findProfileAnchor(
  root: ParentNode,
  baseUrl: string,
): HTMLAnchorElement | undefined {
  for (const selector of OWNER_LINK_SELECTORS) {
    const anchors = Array.from(
      root.querySelectorAll<HTMLAnchorElement>(selector),
    );
    const match = anchors.find(
      (anchor) =>
        parseBilibiliProfileUrl(
          anchor.getAttribute("href") ?? anchor.href,
          baseUrl,
        ) !== undefined,
    );
    if (match !== undefined) {
      return match;
    }
  }
  return undefined;
}

/**
 * 从作者锚点提取身份信息。
 * @param source 身份来源标记（卡片内或搜索模块）
 */
function ownerFromAnchor(
  anchor: HTMLAnchorElement,
  baseUrl: string,
  source: "card" | "search-module",
): {
  uid?: string;
  source: ExtractedCard["uidSource"];
  displayName?: string;
  profileUrl?: string;
} {
  const parsed = parseBilibiliProfileUrl(
    anchor.getAttribute("href") ?? anchor.href,
    baseUrl,
  );
  if (parsed === undefined) {
    return { source: "missing" };
  }
  // 昵称多级兜底：作者子元素 title/文本 → 锚点 title → 锚点文本。
  const namedChild = anchor.querySelector<HTMLElement>(
    ".bili-video-card__info--author",
  );
  const displayName =
    compactText(namedChild?.getAttribute("title")) ??
    compactText(namedChild?.textContent) ??
    compactText(anchor.getAttribute("title")) ??
    compactText(anchor.textContent);
  return {
    uid: parsed.uid,
    source,
    profileUrl: parsed.url.href,
    ...(displayName === undefined
      ? {}
      : { displayName: displayName.slice(0, 200) }),
  };
}

/**
 * 按候选选择器顺序读取文本。
 * @param preferredAttribute 优先读取的属性（如标题的 title 属性更完整）
 */
function readTextBySelectors(
  root: ParentNode,
  selectors: string[],
  preferredAttribute?: string,
): string | undefined {
  for (const selector of selectors) {
    const element = root.querySelector<HTMLElement>(selector);
    if (element === null) {
      continue;
    }
    const fromAttribute =
      preferredAttribute === undefined
        ? undefined
        : compactText(element.getAttribute(preferredAttribute));
    const value = fromAttribute ?? compactText(element.textContent);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/** 读取封面图 alt 文本（部分卡片唯一可用的标题来源）。 */
function readCoverAlt(cardElement: HTMLElement): string | undefined {
  return compactText(
    cardElement.querySelector<HTMLImageElement>("img")?.getAttribute("alt"),
  );
}

/**
 * 规范化图片地址：仅接受 http(s) 协议、长度不超过 2000 的绝对 URL。
 * 防止 data:、javascript: 等异常地址进入存储。
 */
function normalizeHttpUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 2_000) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
