/**
 * 卡片级共享遮罩：广告遮挡与高风险弱化同源。
 *
 * 两套场景（feed-ad-cover 的广告卡、badge-renderer 的高风险卡）曾经各写
 * 一份遮罩样式，颜色和点击行为逐渐漂移。现在统一从这里出：
 * 同一个宿主结构、同一份颜色表、同一种点击封锁。
 *
 * 点击封锁做两层：遮罩本身 pointer-events: auto 吃掉鼠标事件；
 * 再给卡片内除遮罩和徽章宿主以外的子节点加 inert，把键盘 Tab/回车也拦住
 * （pointer-events 管不到键盘）。徽章宿主必须豁免：
 * 弱化只是提示风险，徽章和面板（忽略/白名单/拉黑）仍要可用。
 */
import type { CoverColor } from "../domain/types";
import { HOST_CLASS } from "./badge-renderer";

/** 遮罩场景：广告遮挡 / 高风险弱化。同一卡片可同时各有一个。 */
export type CardCoverKind = "ad" | "dim";

/** 遮罩宿主类名。同一卡片按 kind 区分，靠 dataset 不认类名。 */
const COVER_CLASS = "kcf-card-cover";
/** 徽章宿主类名，inert 时豁免（badge-renderer 的 HOST_CLASS）。 */
const BADGE_HOST_CLASS = HOST_CLASS;

/** 我们加上的 inert 用这个属性做记号，移除时只拆自己挂的。 */
const INERT_FLAG = "data-kcf-inert";
/** 我们隐藏卡片时用 dataset 做记号，恢复显示只动自己藏过的。 */
const HIDDEN_FLAG = "kcfHidden";

interface CoverPalette {
  readonly background: string;
  readonly labelBackground: string;
  readonly labelColor: string;
}

/**
 * 三档颜色都接近不透明：遮罩的职责是盖住内容，半透明白在浅色页面上
 * 会分不清「遮住了」还是「没加载出来」。标签配色随背景翻转保证对比度。
 */
const COVER_PALETTES: Record<CoverColor, CoverPalette> = {
  dark: {
    background: "rgba(24, 25, 28, 0.96)",
    labelBackground: "rgba(255, 255, 255, 0.14)",
    labelColor: "#ffffff",
  },
  light: {
    background: "rgba(247, 249, 250, 0.96)",
    labelBackground: "rgba(0, 0, 0, 0.08)",
    labelColor: "#1c1e21",
  },
  // 接近 B 站表单 disabled 灰，视觉上是「不可用」而不是「强调」。
  gray: {
    background: "rgba(201, 204, 208, 0.96)",
    labelBackground: "rgba(0, 0, 0, 0.1)",
    labelColor: "#3d4045",
  },
};

function coverStyle(palette: CoverPalette): string {
  return `
  :host {
    all: initial;
    position: absolute;
    inset: 0;
    z-index: 25;
    pointer-events: auto;
    border-radius: 8px;
    overflow: hidden;
  }

  .cover {
    position: absolute;
    inset: 0;
    background: ${palette.background};
  }

  .label {
    position: absolute;
    top: 10px;
    left: 10px;
    padding: 4px 8px;
    border-radius: 999px;
    background: ${palette.labelBackground};
    color: ${palette.labelColor};
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Microsoft YaHei", sans-serif;
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
  }
`;
}

/**
 * 给卡片挂上（或更新）一个遮罩。kind 或颜色变化时重建，
 * 两者都一致则不动 DOM，避免闪烁和打断正在进行的交互。
 */
export function ensureCardCover(
  card: HTMLElement,
  options: { kind: CardCoverKind; color: CoverColor; label: string },
): void {
  const existing = findCover(card, options.kind);
  if (
    existing !== undefined &&
    existing.dataset.color === options.color &&
    existing.shadowRoot?.querySelector(".label")?.textContent === options.label
  ) {
    return;
  }
  existing?.remove();

  if (getComputedStyle(card).position === "static") {
    card.style.position = "relative";
  }
  const host = document.createElement("div");
  host.className = COVER_CLASS;
  host.dataset.kcfOwned = "true";
  host.dataset.kind = options.kind;
  host.dataset.color = options.color;
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = coverStyle(COVER_PALETTES[options.color]);
  const cover = document.createElement("div");
  cover.className = "cover";
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = options.label;
  shadow.append(style, cover, label);
  card.append(host);
  applyInert(card);
}

/** 拆掉卡片上指定 kind 的遮罩；没有遮罩时也负责解开 inert。 */
export function removeCardCover(card: HTMLElement, kind: CardCoverKind): void {
  findCover(card, kind)?.remove();
  // 只剩没有任何遮罩时才解开 inert：一张卡可能同时有广告和弱化两个遮罩。
  if (findCover(card, "ad") === undefined && findCover(card, "dim") === undefined) {
    releaseInert(card);
  }
}

/**
 * 直接隐藏整张卡片（display: none），用于广告「直接隐藏」档。
 * 用 inline style 而不是 hidden 属性：B 站自己的卡片类样式可能盖过 [hidden]。
 */
export function setCardHidden(card: HTMLElement, hidden: boolean): void {
  if (hidden) {
    card.dataset[HIDDEN_FLAG] = "true";
    card.style.display = "none";
    return;
  }
  if (card.dataset[HIDDEN_FLAG] === "true") {
    delete card.dataset[HIDDEN_FLAG];
    card.style.display = "";
  }
}

function findCover(
  card: HTMLElement,
  kind: CardCoverKind,
): HTMLElement | undefined {
  const existing = Array.from(card.children).find(
    (element) =>
      element.classList.contains(COVER_CLASS) &&
      (element as HTMLElement).dataset.kind === kind,
  );
  return existing instanceof HTMLElement ? existing : undefined;
}

/** 给卡片内除遮罩与徽章宿主外的直接子节点加 inert，拦截键盘操作。 */
function applyInert(card: HTMLElement): void {
  for (const child of Array.from(card.children)) {
    if (!(child instanceof HTMLElement)) {
      continue;
    }
    if (
      child.classList.contains(COVER_CLASS) ||
      child.classList.contains(BADGE_HOST_CLASS)
    ) {
      continue;
    }
    if (!child.hasAttribute("inert")) {
      child.setAttribute("inert", "");
      child.setAttribute(INERT_FLAG, "true");
    }
  }
}

function releaseInert(card: HTMLElement): void {
  for (const child of Array.from(card.querySelectorAll(`[${INERT_FLAG}]`))) {
    child.removeAttribute("inert");
    child.removeAttribute(INERT_FLAG);
  }
}
