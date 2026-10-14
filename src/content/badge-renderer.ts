/**
 * 风险标签渲染器：在视频卡片上挂载 Shadow DOM 风险标签与解释面板。
 *
 * 设计要点：
 * - 全部样式与 DOM 封装在 open Shadow Root 内，不与宿主页面互相污染；
 * - 状态未变化时跳过重绘（渲染去重），用户展开的面板不会被重复扫描关闭；
 * - 交互按钮与 aria 标注齐备，支持键盘操作（Esc 关闭面板）。
 */
import type {
  AccountAnalysis,
  ExtensionSettings,
} from "../domain/types";
import type { ExtractedCard } from "../adapters/contract";

/** 标签宿主元素的类名（挂在卡片根元素下，便于识别与清理）。 */
export const HOST_CLASS = "kcf-badge-host";

/**
 * 面板展开期间宿主与卡片使用的临时层级。
 * 卡片通常是 relative + z-index:auto（不构成层叠上下文），宿主的 z-index 会
 * 直接与相邻卡片的宿主比拼，同值时 DOM 更靠后的卡片绘制在上层——不抬高就会
 * 出现「下方卡片的徽章盖住上方卡片展开的面板」。
 */
const OPEN_PANEL_Z_INDEX = "2147483646";
/** 展开后面板挂到这个视口层，避免被视频卡片的 overflow:hidden 裁掉。 */
const FLOAT_HOST_ID = "kcf-panel-float";
const PANEL_MARGIN_PX = 8;

/**
 * 把宿主及其已定位的父卡片抬到页面最顶层。
 * @returns 还原函数：关闭面板时恢复各元素原有内联 z-index
 */
function raiseStackingForPanel(host: HTMLElement): () => void {
  const restorable: [HTMLElement, string][] = [];
  // 卡片是 position:relative，抬它的 z-index 会让整张卡片（含面板）作为一个
  // 层叠单元压在相邻卡片之上；静态定位元素设 z-index 无效，直接跳过。
  const card = host.parentElement;
  if (card instanceof HTMLElement && getComputedStyle(card).position !== "static") {
    restorable.push([card, card.style.zIndex]);
    card.style.zIndex = OPEN_PANEL_Z_INDEX;
  }
  restorable.push([host, host.style.zIndex]);
  host.style.zIndex = OPEN_PANEL_Z_INDEX;
  return () => {
    for (const [element, previous] of restorable) {
      element.style.zIndex = previous;
    }
  };
}

/** Shadow DOM 内的全部样式。 */
const STYLE = `
  :host {
    all: initial;
    position: absolute;
    inset: 0;
    z-index: 30;
    pointer-events: none;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Microsoft YaHei", sans-serif;
    color: #18191c;
  }

  .badge {
    position: absolute;
    top: 8px;
    left: 8px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 26px;
    padding: 4px 9px;
    border: 1px solid rgba(255, 255, 255, 0.76);
    border-radius: 999px;
    box-shadow: 0 3px 12px rgba(0, 0, 0, 0.16);
    color: #fff;
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    pointer-events: auto;
  }

  .badge.low { background: #168a52; }
  .badge.suspicious { background: #b56b00; }
  .badge.high { background: #c9343f; }
  .badge.muted { background: #61666d; }

  /* 值得复核只表示「值得花一次 AI 调用」，不是高风险结论。
     白字必须配实心底：按钮默认底色是 #f0f0f0，不写这条规则就几乎读不清。
     用冷蓝，避开高风险红 #c9343f 和白名单蓝 #1683d8。 */
  .badge.trigger { background: #1e5a8a; }

  /* AI 判定失败态：虚线边框 + 琥珀色，与「本地没触发」的中性灰区分开，
     提示「这次没有拿到 AI 结论」，别让用户误读成「没问题」。 */
  .badge.degraded {
    border-style: dashed;
    border-color: rgba(120, 72, 0, 0.9);
    box-shadow: 0 0 0 1px rgba(176, 108, 0, 0.35), 0 3px 12px rgba(0, 0, 0, 0.16);
  }  .badge.whitelisted { background: #1683d8; }
  .badge.candidate { background: #7a45c4; }

  .panel {
    position: absolute;
    top: 40px;
    left: 8px;
    width: min(320px, calc(100vw - 16px));
    height: auto;
    min-height: 0;
    max-height: none;
    overflow: auto;
    overscroll-behavior: contain;
    box-sizing: border-box;
    padding: 16px 16px 12px;
    border: 0;
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.94);
    color: #1d1d1f;
    box-shadow:
      0 0 0 0.5px rgba(0, 0, 0, 0.08),
      0 16px 40px rgba(0, 0, 0, 0.16);
    backdrop-filter: saturate(180%) blur(22px);
    -webkit-backdrop-filter: saturate(180%) blur(22px);
    pointer-events: auto;
  }

  .panel[hidden] { display: none; }

  .sheet-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin: 0 0 12px;
    padding-bottom: 12px;
    border-bottom: 0.5px solid rgba(60, 60, 67, 0.16);
  }

  .sheet-copy {
    min-width: 0;
  }

  .title {
    margin: 0;
    color: #1d1d1f;
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.022em;
    line-height: 1.25;
  }

  .meta {
    margin: 4px 0 0;
    color: #6e6e73;
    font-size: 12px;
    line-height: 1.35;
  }

  .score {
    flex: none;
    margin: 1px 0 0;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.03em;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .score.low { color: #248a3d; }
  .score.suspicious { color: #c93400; }
  .score.high { color: #d70015; }

  .sheet-body {
    display: grid;
    gap: 8px;
    margin: 0 0 14px;
  }

  .reasons {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .reason {
    color: #1d1d1f;
    font-size: 13px;
    line-height: 1.45;
  }

  .reason::before {
    content: "•";
    margin-right: 6px;
    color: #9499a0;
  }

  .notice {
    margin: 0;
    padding: 0;
    background: transparent;
    color: #1d1d1f;
    font-size: 13px;
    font-weight: 400;
    line-height: 1.45;
  }

  .notice.hint {
    background: transparent;
    color: #6e6e73;
    font-size: 12px;
  }

  .notice.ai-notice,
  .notice.ai-notice.primary {
    border-left: 0;
    background: transparent;
    color: #1d1d1f;
    font-weight: 400;
  }

  /* 粉丝数与证据缺口都是次级信息，不跟结论抢同一块底色。 */
  .meta.audience {
    margin-top: 2px;
    color: #6e6e73;
    font-variant-numeric: tabular-nums;
  }

  .notice.ai-gaps {
    background: transparent;
    color: #6e6e73;
    font-size: 12px;
    line-height: 1.4;
  }

  .block-confirm {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 0 0 10px;
    padding: 10px 12px;
    border-radius: 12px;
    background: rgba(255, 59, 48, 0.1);
    color: #d70015;
    font-size: 12px;
    line-height: 1.45;
  }

  .block-confirm p {
    flex: 1 1 100%;
    margin: 0;
  }

  .block-confirm .action {
    flex: 1 1 0;
  }

  .actions {
    display: grid;
    gap: 8px;
  }

  .action-row.marks {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    margin-top: 2px;
    padding-top: 2px;
    border-top: 0.5px solid rgba(60, 60, 67, 0.12);
    background: transparent;
  }

  .action-row.decide {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .action {
    appearance: none;
    min-height: 32px;
    padding: 6px 8px;
    border: 0;
    border-radius: 10px;
    background: rgba(120, 120, 128, 0.12);
    color: #1d1d1f;
    font-family: inherit;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.2;
    cursor: pointer;
  }

  .marks .action {
    min-height: 28px;
    background: transparent;
    color: #6e6e73;
    font-size: 12px;
    font-weight: 500;
  }

  .marks .action:hover {
    background: transparent;
    color: #1d1d1f;
  }

  .decide .action {
    flex: 1 1 0;
  }

  .decide .action.primary,
  .action.primary {
    flex: 1 1 100%;
    background: #007aff;
    color: #fff;
  }

  .action.destructive {
    background: rgba(255, 59, 48, 0.1);
    color: #d70015;
  }

  .action:hover { background: rgba(120, 120, 128, 0.18); }
  .action.primary:hover { background: #0066d6; }
  .action.destructive:hover { background: rgba(255, 59, 48, 0.16); }

  .badge:focus-visible,
  .action:focus-visible {
    outline: 2px solid #007aff;
    outline-offset: 2px;
  }

  .panel:focus {
    outline: none;
  }

  /* 深色模式：跟随系统。:host 的 color 是浅色正文，不改的话漏网的字会是近黑。 */
  @media (prefers-color-scheme: dark) {
    :host {
      color-scheme: dark;
      color: #e7e9ee;
    }

    .panel {
      background: rgba(44, 44, 46, 0.94);
      color: #f2f4f8;
      box-shadow:
        0 0 0 0.5px rgba(255, 255, 255, 0.12),
        0 16px 40px rgba(0, 0, 0, 0.55);
    }

    .sheet-head {
      border-color: rgba(255, 255, 255, 0.12);
    }

    .title {
      color: #f2f4f8;
    }

    .meta,
    .meta.audience,
    .reason {
      color: #d5dbe6;
    }

    .reason::before {
      color: #aeb6c2;
    }

    .score.low { color: #32d74b; }
    .score.suspicious { color: #ffd60a; }
    .score.high { color: #ff6961; }

    .notice,
    .notice.hint,
    .notice.ai-gaps {
      background: transparent;
      color: #e4eaf4;
    }

    .notice.ai-notice,
    .notice.ai-notice.primary {
      border-left-color: transparent;
      background: transparent;
      color: #e7f0ff;
    }

    .block-confirm {
      background: #3a1e22;
      color: #ffc1c4;
    }

    .action {
      background: rgba(120, 120, 128, 0.32);
      color: #f2f4f8;
    }

    .action-row.marks {
      background: transparent;
      border-top-color: rgba(255, 255, 255, 0.12);
    }

    .marks .action {
      background: transparent;
      color: #d5dbe6;
    }

    .marks .action:hover {
      background: transparent;
      color: #f2f4f8;
    }

    .action:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .action.primary,
    .decide .action.primary {
      background: #0a84ff;
      color: #fff;
    }

    .action.primary:hover {
      background: #409cff;
    }

    .action.destructive {
      background: rgba(255, 69, 58, 0.2);
      color: #ffc1c4;
    }
  }
`;

/** 标签面板上的处置操作：目标名单与是否选中。 */
export interface BadgeAction {
  disposition: "whitelisted" | "ignored" | "candidate";
  selected: boolean;
}

// 记录每个卡片宿主上一次渲染的状态签名；状态未变化时跳过重绘，
// 既避免长列表滚动时的 DOM 抖动，也让用户展开的面板保持打开。
const renderedStamps = new WeakMap<HTMLElement, string>();

/**
 * 已拉黑账号集合：由内容脚本从本地拉黑记录同步（refreshBlockedAccounts），
 * 渲染时用于把面板按钮初始化为「取消拉黑」状态。
 */
const blockedAccountKeys = new Set<string>();

/**
 * AI 判定失败的账号集合：由内容脚本在复核失败时同步
 * （refreshAiUnavailable），渲染时用于把徽章标成「未取得结论」态。
 *
 * 为什么需要：判定只由 AI 产出，失败后账号没有任何结论。若不加标记，
 * 徽章与「本地没触发」的中性态长得一样——用户会以为「没提示」等于
 * 「没问题」，而这正是最需要提醒的情形（接口限流/鉴权失败时，
 * 一批账号会同时失去判定）。
 */
const aiUnavailableKeys = new Set<string>();

/**
 * 在卡片上渲染（或复用）标签。
 *
 * @param card 提取出的卡片数据（含渲染挂载点）
 * @param analysis 账号分析结果；undefined 时渲染中性标签（解析不出稳定 UID）
 * @param settings 用户设置（控制弱化开关、AI 判定入口等）
 * @param onAction 处置操作回调（加入白名单/忽略/待处理）
 * @param onAiReview AI 判定触发回调；未提供或未启用 AI 时不显示按钮
 * @param onOpenProfile 深度判定回调（打开 UP 主主页获取完整投稿与简介）
 * @param onBlock 拉黑/取消拉黑回调；提供时面板显示拉黑按钮（含二次确认）
 * @param blockedStateProvider 面板打开时核对 B 站真实拉黑状态（本地记录可能过期）
 */
export function renderBadge(
  card: ExtractedCard,
  analysis: AccountAnalysis | undefined,
  settings: ExtensionSettings,
  onAction: (action: BadgeAction) => Promise<void>,
  onAiReview?: () => Promise<void>,
  onOpenProfile?: () => Promise<void>,
  onBlock?: (action: "block" | "unblock") => Promise<void>,
  blockedStateProvider?: (uid: string) => Promise<boolean | null>,
): void {
  // 点击页面任意位置可关闭已展开的面板（全局只挂一次）。
  ensureOutsideClickListener();
  const stamp = renderStamp(
    card,
    analysis,
    settings,
    onAiReview,
  );
  const existing = findHost(card.mount.cardElement);
  // 签名一致且 Shadow Root 存活时直接复用现有标签，保留面板展开状态。
  if (
    existing !== undefined &&
    existing.shadowRoot !== null &&
    renderedStamps.get(existing) === stamp
  ) {
    return;
  }
  if (openSession?.host === existing) {
    closeOpenPanel();
  }

  const host = getOrCreateHost(card.mount.cardElement);
  const root = host.shadowRoot;
  if (root === null) {
    return;
  }
  renderedStamps.set(host, stamp);
  root.replaceChildren();

  const style = document.createElement("style");
  style.textContent = STYLE;
  root.append(style);

  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = `badge ${badgeVariant(analysis)}`;
  badge.textContent = badgeText(analysis);
  badge.setAttribute("aria-expanded", "false");
  badge.setAttribute("aria-haspopup", "true");
  badge.setAttribute("aria-label", badgeAriaLabel(analysis));
  root.append(badge);

  const { panel, setBlockedState } = buildPanel(
    card,
    analysis,
    settings,
    onAction,
    onAiReview,
    onOpenProfile,
    onBlock,
    blockedAccountKeys.has(analysis?.accountKey ?? ""),
    // Esc 关闭时同步还原层级抬升（buildPanel 内的键盘处理先于本监听执行）。
    () => setPanelOpen(false),
  );
  panel.hidden = true;
  root.append(panel);

  /** 切换面板开合。展开时把面板搬到视口层，避免被卡片裁切。 */
  function setPanelOpen(open: boolean): void {
    if (open) {
      closeAllOpenPanels(host);
      panel.hidden = false;
      badge.setAttribute("aria-expanded", "true");
      const home = panel.parentNode;
      if (home === null) {
        return;
      }
      floatRoot().append(panel);
      const restoreStacking = raiseStackingForPanel(host);
      const place = (): void => {
        placeOpenPanel(panel, badge);
      };
      openSession = { host, panel, badge, home, restoreStacking, place };
      window.addEventListener("scroll", onViewportChange, true);
      window.addEventListener("resize", onViewportChange);
      place();
      panel.focus();
      // 异步核对 B 站真实的拉黑状态：本地记录可能过期（用户可能已通过
      // B 站官方途径解除拉黑），核对后以真实状态为准并同步本地记录。
      if (blockedStateProvider !== undefined && analysis !== undefined) {
        void blockedStateProvider(analysis.uid).then((live) => {
          if (live !== null) {
            setBlockedState(live);
          }
        });
      }
      return;
    }
    if (openSession?.panel === panel) {
      closeOpenPanel();
      badge.focus();
      return;
    }
    panel.hidden = true;
    badge.setAttribute("aria-expanded", "false");
  }

  badge.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    // panel.hidden 的 IDL 类型是 string|boolean，本插件只写布尔值。
    setPanelOpen(panel.hidden === true);
  });
}

interface OpenPanelSession {
  host: HTMLElement;
  panel: HTMLDivElement;
  badge: HTMLButtonElement;
  home: ParentNode;
  restoreStacking: () => void;
  place: () => void;
}

let openSession: OpenPanelSession | undefined;

function onViewportChange(): void {
  openSession?.place();
}

/** 视口层的 Shadow Root。面板展开时搬进来，样式与卡片内同一份。 */
function floatRoot(): ShadowRoot {
  const existing = document.getElementById(FLOAT_HOST_ID);
  if (existing instanceof HTMLElement && existing.shadowRoot !== null) {
    return existing.shadowRoot;
  }
  const host = document.createElement("div");
  host.id = FLOAT_HOST_ID;
  document.documentElement.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `${STYLE}
    :host {
      position: fixed !important;
      inset: 0 !important;
      z-index: 2147483647 !important;
      pointer-events: none !important;
      overflow: visible !important;
    }
  `;
  shadow.append(style);
  return shadow;
}

/**
 * 把已展开的面板贴在徽章旁。
 * 高度按内容撑开；只在下方或上方的屏幕剩余空间不够时才限制 max-height 并滚动。
 */
function placeOpenPanel(panel: HTMLElement, badge: HTMLElement): void {
  const rect = badge.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(320, Math.max(160, viewportWidth - PANEL_MARGIN_PX * 2));
  panel.style.position = "fixed";
  panel.style.width = `${width}px`;
  panel.style.maxHeight = "none";
  const needed = panel.scrollHeight;
  const spaceBelow = Math.max(0, viewportHeight - rect.bottom - PANEL_MARGIN_PX);
  const spaceAbove = Math.max(0, rect.top - PANEL_MARGIN_PX);
  const openDown = needed <= spaceBelow || spaceBelow >= spaceAbove;
  const available = Math.max(96, openDown ? spaceBelow : spaceAbove);
  const height = Math.min(needed, available);
  panel.style.maxHeight = `${available}px`;
  let top = openDown ? rect.bottom + 6 : rect.top - 6 - height;
  const maxTop = viewportHeight - PANEL_MARGIN_PX - Math.min(height, available);
  top = Math.max(PANEL_MARGIN_PX, Math.min(top, maxTop));
  let left = rect.left;
  if (left + width > viewportWidth - PANEL_MARGIN_PX) {
    left = viewportWidth - PANEL_MARGIN_PX - width;
  }
  left = Math.max(PANEL_MARGIN_PX, left);
  panel.style.top = `${top}px`;
  panel.style.left = `${left}px`;
}

function schedulePlace(panel: HTMLElement): void {
  if (openSession?.panel !== panel) {
    return;
  }
  queueMicrotask(() => {
    if (openSession?.panel === panel && !panel.hidden) {
      openSession.place();
    }
  });
}

function closeOpenPanel(): void {
  const session = openSession;
  if (session === undefined) {
    return;
  }
  openSession = undefined;
  window.removeEventListener("scroll", onViewportChange, true);
  window.removeEventListener("resize", onViewportChange);
  session.panel.hidden = true;
  session.panel.style.position = "";
  session.panel.style.top = "";
  session.panel.style.left = "";
  session.panel.style.width = "";
  session.panel.style.maxHeight = "";
  session.home.append(session.panel);
  session.badge.setAttribute("aria-expanded", "false");
  session.restoreStacking();
}

/** 同步本地拉黑记录到渲染器（内容脚本加载与拉黑操作后调用）。 */
export function refreshBlockedAccounts(accountKeys: Iterable<string>): void {
  blockedAccountKeys.clear();
  for (const key of accountKeys) {
    blockedAccountKeys.add(key);
  }
}

/**
 * 同步「AI 判定失败」的账号清单。
 * 复核成功后调用方应把该账号移出，让徽章恢复成 AI 主结论形态。
 */
export function refreshAiUnavailable(accountKeys: Iterable<string>): void {
  aiUnavailableKeys.clear();
  for (const key of accountKeys) {
    aiUnavailableKeys.add(key);
  }
}

/**
 * 关闭页面上所有已展开的面板（可排除一个宿主，用于「打开新面板时
 * 关闭其他面板」）。
 */
function closeAllOpenPanels(exceptHost?: HTMLElement): void {
  if (openSession !== undefined && openSession.host !== exceptHost) {
    closeOpenPanel();
  }
  document.querySelectorAll(`.${HOST_CLASS}`).forEach((element) => {
    if (element === exceptHost) {
      return;
    }
    const shadow = (element as HTMLElement).shadowRoot;
    const panel = shadow?.querySelector<HTMLDivElement>(".panel");
    if (panel !== null && panel !== undefined && !panel.hidden) {
      panel.hidden = true;
      shadow
        ?.querySelector<HTMLButtonElement>(".badge")
        ?.setAttribute("aria-expanded", "false");
    }
  });
}

/**
 * 判断一次点击是否发生在本插件的 UI（徽章/面板）之内。
 * Shadow DOM 内的点击在文档层会把 target 重定向到宿主元素；
 * 同时用 composedPath 与宿主链兜底，兼容测试环境。
 */
function isInsideOurUi(event: Event): boolean {
  if (
    event
      .composedPath()
      .some(
        (node) =>
          node instanceof Element &&
          (node.classList.contains(HOST_CLASS) || node.id === FLOAT_HOST_ID),
      )
  ) {
    return true;
  }
  let node = event.target;
  while (node instanceof Element) {
    if (node.classList.contains(HOST_CLASS)) {
      return true;
    }
    const root = node.getRootNode();
    if (root instanceof ShadowRoot) {
      node = root.host;
    } else {
      return false;
    }
  }
  return false;
}

let outsideClickListenerAttached = false;

/**
 * 点击插件 UI 之外的任何位置（B 站页面任意处）都会关闭已展开的面板。
 * 监听器全局只挂一次；用捕获阶段保证不被 B 站自身的 stopPropagation 拦掉。
 */
function ensureOutsideClickListener(): void {
  if (outsideClickListenerAttached) {
    return;
  }
  outsideClickListenerAttached = true;
  document.addEventListener(
    "click",
    (event) => {
      if (!isInsideOurUi(event)) {
        closeAllOpenPanels();
      }
    },
    true,
  );
}

/** 移除页面上全部由本插件创建的标签宿主。 */
export function removeAllBadges(): void {
  closeOpenPanel();
  document.getElementById(FLOAT_HOST_ID)?.remove();
  document.querySelectorAll(`.${HOST_CLASS}`).forEach((element) => {
    element.remove();
  });
}

/**
 * 查找或创建卡片上的标签宿主元素。
 * 静态定位的卡片会被改为 relative，保证标签的绝对定位正确。
 */
function getOrCreateHost(cardElement: HTMLElement): HTMLElement {
  const existing = findHost(cardElement);
  if (existing !== undefined) {
    return existing;
  }

  const host = document.createElement("div");
  host.className = HOST_CLASS;
  host.dataset.kcfOwned = "true";
  if (getComputedStyle(cardElement).position === "static") {
    cardElement.style.position = "relative";
  }
  host.attachShadow({ mode: "open" });
  cardElement.append(host);
  return host;
}

/** 在卡片子元素中查找已存在的标签宿主。 */
function findHost(cardElement: HTMLElement): HTMLElement | undefined {
  const existing = Array.from(cardElement.children).find((element) =>
    element.classList.contains(HOST_CLASS),
  );
  return existing instanceof HTMLElement ? existing : undefined;
}

/**
 * 计算渲染状态签名：覆盖标签文本、面板内容与 AI 入口的全部输入。
 * 任何影响视觉输出的字段变化都会产生不同签名，触发真实重绘。
 * 弱化遮罩不在其中：它是卡片级共享遮罩（card-cover），由 content-script 维护。
 */
function renderStamp(
  card: ExtractedCard,
  analysis: AccountAnalysis | undefined,
  settings: ExtensionSettings,
  onAiReview?: () => Promise<void>,
): string {
  return JSON.stringify({
    cardKey: card.cardKey,
    displayName: analysis?.displayName ?? card.displayName,
    aiEnabled: settings.aiEnabled && onAiReview !== undefined,
    // AI 判定失败态必须进签名：徽章文本与配色都依赖它，
    // 漏掉的话复核失败后徽章不会重绘，用户看不到「本次未取得结论」。
    aiUnavailable: analysis !== undefined && aiUnavailableKeys.has(analysis.accountKey),
    analysis:
      analysis === undefined
        ? null
        : {
            reviewKind: analysis.review.kind,
            observedVideos: analysis.observedVideos,
            disposition: analysis.disposition,
            // 触发器命中时列出事实性描述，「为什么提示你复核」。
            triggers:
              analysis.review.kind === "triggered"
                ? analysis.review.triggers.map((hit) => hit.detail)
                : [],
            aiProbability:
              analysis.review.kind === "ai"
                ? analysis.review.review.marketingProbability
                : null,
          },
  });
}

/** 把粉丝数/投稿数格式化成一行；未开启补全时返回 null（不展示该行）。 */
function formatAudience(analysis: AccountAnalysis | undefined): string | null {
  if (analysis === undefined) {
    return null;
  }
  if (analysis.followers === undefined && analysis.archiveCount === undefined) {
    return null;
  }
  const parts: string[] = [];
  if (analysis.followers !== undefined) {
    parts.push(`粉丝 ${formatCount(analysis.followers)}`);
  }
  if (analysis.archiveCount !== undefined) {
    parts.push(`投稿 ${formatCount(analysis.archiveCount)}`);
  }
  return parts.join(" · ");
}

/** 大数字紧凑显示：12345 → 1.2万。 */
function formatCount(value: number): string {
  if (value < 10_000) {
    return String(value);
  }
  const wan = value / 10_000;
  return `${wan >= 100 ? Math.round(wan) : Math.round(wan * 10) / 10}万`;
}

/**
 * 构建解释面板：账号名、当前判定、事实或 AI 理由、
 * 免责提示与处置按钮。
 */
function buildPanel(
  card: ExtractedCard,
  analysis: AccountAnalysis | undefined,
  settings: ExtensionSettings,
  onAction: (action: BadgeAction) => Promise<void>,
  onAiReview?: () => Promise<void>,
  onOpenProfile?: () => Promise<void>,
  onBlock?: (action: "block" | "unblock") => Promise<void>,
  /** 初始是否已拉黑（内容脚本从本地记录读入）；缺省为未拉黑。 */
  initialBlocked?: boolean,
  onClose?: () => void,
): { panel: HTMLDivElement; setBlockedState: (blocked: boolean) => void } {
  const panel = document.createElement("div");
  panel.className = "panel";
  // tabindex=-1 允许脚本聚焦面板（展开时移入焦点），但不进入 Tab 序列。
  panel.tabIndex = -1;
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "风险依据与处理操作");
  panel.addEventListener("click", (event) => event.stopPropagation());
  panel.addEventListener("keydown", (event) => {
    // Esc 关闭面板并把焦点还给徽章按钮。
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose?.();
    }
  });

  // 面板内容与内联状态（拉黑二次确认、已拉黑状态）分离：
  // 状态变化时局部重绘，不影响外层展开状态与焦点。
  let blockConfirmOpen = false;
  let blockState: "none" | "blocked" = initialBlocked === true ? "blocked" : "none";
  const setBlockedState = (blocked: boolean): void => {
    blockState = blocked ? "blocked" : "none";
    renderPanelContent();
  };
  function renderPanelContent(): void {
    panel.replaceChildren();

  const head = document.createElement("div");
  head.className = "sheet-head";
  const copy = document.createElement("div");
  copy.className = "sheet-copy";

  const title = document.createElement("p");
  title.className = "title";
  title.textContent =
    analysis?.displayName ?? card.displayName ?? "未识别账号";
  copy.append(title);

  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent =
    analysis === undefined
      ? "未解析出稳定 UID，本卡片不会写入本地观察库。"
      : `已观察 ${analysis.observedVideos} 条投稿`;
  copy.append(meta);

  // 公开名片数据（需用户在设置页开启补全）。只展示，并已由 review-client
  // 写进 AI 提示词——「投稿数 / 粉丝数」是农场比例信号，把这个判断留给 AI。
  const audience = formatAudience(analysis);
  if (audience !== null) {
    const audienceLine = document.createElement("p");
    audienceLine.className = "meta audience";
    audienceLine.textContent = audience;
    copy.append(audienceLine);
  }
  head.append(copy);

  const aiReview =
    analysis?.review.kind === "ai" ? analysis.review.review : undefined;
  if (aiReview !== undefined) {
    const score = document.createElement("p");
    score.className = `score ${scoreTone(aiReview.marketingProbability)}`;
    score.textContent = `${aiReview.marketingProbability}%`;
    head.append(score);
  }
  panel.append(head);

  const body = document.createElement("div");
  body.className = "sheet-body";

  // AI 结论：唯一的判定来源，语义判断优先完整呈现。
  if (aiReview !== undefined) {
    const aiNotice = document.createElement("p");
    aiNotice.className = "notice ai-notice primary";
    aiNotice.textContent = `AI 判定（${aiReview.model}）：营销号概率 ${aiReview.marketingProbability}% —— ${aiReview.reason}`;
    body.append(aiNotice);
    // 模型声明的证据缺口：这个结论缺了哪类材料。用户据此决定要不要打开主页核实。
    if (aiReview.insufficientData.length > 0) {
      const gaps = document.createElement("p");
      gaps.className = "notice ai-gaps";
      gaps.textContent = `AI 自陈证据不足：${aiReview.insufficientData.join("；")}`;
      body.append(gaps);
    }
  }

  // 本地触发器命中：只陈述事实，不给结论。
  if (analysis !== undefined && analysis.review.kind === "triggered") {
    const heading = document.createElement("p");
    heading.className = "notice hint";
    heading.textContent = "本地注意到以下事实（这不构成判定）：";
    body.append(heading);
    const facts = document.createElement("ul");
    facts.className = "reasons";
    for (const hit of analysis.review.triggers) {
      const item = document.createElement("li");
      item.className = "reason";
      item.textContent = hit.detail;
      facts.append(item);
    }
    body.append(facts);
    const cta = document.createElement("p");
    cta.className = "notice hint";
    cta.textContent =
      onAiReview !== undefined
        ? "这些只是便宜的事实信号，是不是营销号由 AI 语义判断回答——点下方「AI 判定」。"
        : "在设置页配置 AI 判定后，点「AI 判定」即可得到语义判断。";
    body.append(cta);
  }

  // 未配置 AI 时直接说明当前无法给出判断。
  if (!settings.aiEnabled) {
    const missing = document.createElement("p");
    missing.className = "notice hint";
    missing.textContent =
      "本插件的判定完全由 AI 产出。尚未在设置页配置 AI 接口，因此当前无法给出判断——配置后点「AI 判定」即可对该账号做语义判定。";
    body.append(missing);
  } else if (
    analysis !== undefined &&
    analysis.review.kind === "none" &&
    aiReview === undefined
  ) {
    const quiet = document.createElement("p");
    quiet.className = "notice hint";
    quiet.textContent =
      "本地未注意到值得复核的信号。你仍然可以点下方「AI 判定」让它判断这个账号。";
    body.append(quiet);
  }

  if (aiReview !== undefined) {
    // 免责提示：说明这是模型自陈概率、有保鲜期，最终决定始终在用户。
    const notice = document.createElement("p");
    notice.className = "notice hint";
    notice.textContent =
      "以上是 AI 给出的概率判断（不是事实认定，也未经过标注集校准）；结论在本机缓存 7 天。最终处理决定始终由你完成。";
    body.append(notice);
  }

  if (body.childElementCount > 0) {
    panel.append(body);
  }

  if (analysis !== undefined) {
    // 重新判定、深度判定、拉黑放在上面；名单三个收到分隔线下面。
    const actions = document.createElement("div");
    actions.className = "actions";
    const marks = document.createElement("div");
    marks.className = "action-row marks";
    const decide = document.createElement("div");
    decide.className = "action-row decide";
    // 深度判定单独占满第一行，重新判定与拉黑并排在它下面。
    if (onOpenProfile !== undefined) {
      decide.append(
        actionButton("深度判定（打开主页）", true, onOpenProfile),
      );
    }
    if (settings.aiEnabled && onAiReview !== undefined) {
      decide.append(
        actionButton(
          aiReview === undefined ? "AI 判定" : "重新判定",
          false,
          onAiReview,
        ),
      );
    }
    if (onBlock !== undefined && !blockConfirmOpen) {
      decide.append(
        actionButton(
          blockState === "blocked" ? "取消拉黑" : "拉黑",
          false,
          async () => {
            blockConfirmOpen = true;
            renderPanelContent();
          },
          "destructive",
        ),
      );
    }
    if (decide.childElementCount > 0) {
      actions.append(decide);
    }
    marks.append(
      actionButton(
        analysis.disposition === "ignored" ? "取消忽略" : "忽略",
        false,
        () =>
          onAction({
            disposition: "ignored",
            selected: analysis.disposition !== "ignored",
          }),
      ),
      actionButton(
        analysis.disposition === "whitelisted"
          ? "移出白名单"
          : "加入白名单",
        false,
        () =>
          onAction({
            disposition: "whitelisted",
            selected: analysis.disposition !== "whitelisted",
          }),
      ),
      actionButton(
        analysis.disposition === "candidate"
          ? "移出待处理"
          : "加入待处理",
        false,
        () =>
          onAction({
            disposition: "candidate",
            selected: analysis.disposition !== "candidate",
          }),
      ),
    );
    actions.append(marks);
    panel.append(actions);
    if (onBlock !== undefined && blockConfirmOpen) {
      const confirmArea = document.createElement("div");
      confirmArea.className = "block-confirm";
      const text = document.createElement("p");
      text.textContent = blockState === "blocked"
        ? `确认取消拉黑「${analysis.displayName ?? card.displayName ?? "该账号"}」？`
        : `确认拉黑「${analysis.displayName ?? card.displayName ?? "该账号"}」？拉黑是平台动作，可在 B 站设置或本插件的「取消拉黑」中撤销。`;
      confirmArea.append(text);
      const wasBlocked = blockState === "blocked";
      const yes = actionButton(
        wasBlocked ? "确认取消拉黑" : "确认拉黑",
        false,
        async () => {
          blockConfirmOpen = false;
          // 平台调用成功后才翻转本地状态；失败则保持原状并重绘。
          await onBlock(wasBlocked ? "unblock" : "block");
          blockState = wasBlocked ? "none" : "blocked";
          renderPanelContent();
        },
        "destructive",
      );
      const no = actionButton("取消", false, async () => {
        blockConfirmOpen = false;
        renderPanelContent();
      });
      confirmArea.append(yes, no);
      panel.insertBefore(confirmArea, actions);
    }
  }

  schedulePlace(panel);
  }

  renderPanelContent();
  return { panel, setBlockedState };
}

/**
 * 创建处置按钮：请求进行期间禁用，防止重复提交。
 * @param primary 实心蓝按钮。弹出层里只给「深度判定」用。
 * @param tone `destructive` 用于拉黑，红字浅底。
 */
function actionButton(
  text: string,
  primary: boolean,
  action: () => Promise<void>,
  tone?: "destructive",
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `action${primary ? " primary" : ""}${tone === "destructive" ? " destructive" : ""}`;
  button.textContent = text;
  button.addEventListener("click", () => {
    button.disabled = true;
    void action().finally(() => {
      button.disabled = false;
    });
  });
  return button;
}

/** AI 概率的展示分档：徽章颜色和弱化遮罩共用这两个常量。 */
const AI_HIGH_MARK = 80;
const AI_SUSPICIOUS_MARK = 60;

/** 抬头大数字的颜色，和徽章分档用同一对阈值。 */
function scoreTone(probability: number): "low" | "suspicious" | "high" {
  if (probability >= AI_HIGH_MARK) {
    return "high";
  }
  if (probability >= AI_SUSPICIOUS_MARK) {
    return "suspicious";
  }
  return "low";
}

/** 是否为 AI 判定的高风险（弱化遮罩的判定条件之一，content-script 也用）。 */
export function isHighRisk(analysis: AccountAnalysis | undefined): boolean {
  return (
    analysis?.review.kind === "ai" &&
    analysis.review.review.marketingProbability >= AI_HIGH_MARK
  );
}

/** 标签短文本（emoji 前缀 + 当前判定状态）。 */
function badgeText(analysis: AccountAnalysis | undefined): string {
  if (analysis === undefined) {
    return "⚪ 无账号信息";
  }
  if (analysis.disposition === "whitelisted") {
    return "🔵 白名单";
  }
  if (analysis.disposition === "ignored") {
    return "⚪ 已忽略";
  }
  if (analysis.disposition === "candidate") {
    return "🟣 待处理";
  }
  // AI 结论是唯一需要展示的判定。
  if (analysis.review.kind === "ai") {
    return `AI ${analysis.review.review.marketingProbability}%`;
  }
  // 本地触发器命中：只提示「值得复核」，不给任何分数或档位。
  if (analysis.review.kind === "triggered") {
    return "🔎 值得复核";
  }
  if (aiUnavailableKeys.has(analysis.accountKey)) {
    return "⚪ AI 未取得结论";
  }
  return "⚪ 无判定";
}

/**
 * 徽章配色。
 *
 * 有 AI 结论时按概率分档；触发器命中用独立的 trigger 配色——刻意不与
 * 高风险的红色系混淆，避免用户把「值得复核」读成「这是营销号」。
 * AI 判定失败用 degraded，提示本次没拿到结论。
 */
function badgeVariant(analysis: AccountAnalysis | undefined): string {
  if (analysis === undefined || analysis.disposition === "ignored") {
    return "muted";
  }
  if (analysis.disposition === "whitelisted") {
    return "whitelisted";
  }
  if (analysis.disposition === "candidate") {
    return "candidate";
  }
  if (analysis.review.kind === "ai") {
    const probability = analysis.review.review.marketingProbability;
    if (probability >= AI_HIGH_MARK) {
      return "high";
    }
    if (probability >= AI_SUSPICIOUS_MARK) {
      return "suspicious";
    }
    return "low";
  }
  if (analysis.review.kind === "triggered") {
    return "trigger";
  }
  if (aiUnavailableKeys.has(analysis.accountKey)) {
    return "degraded";
  }
  return "muted";
}

/** 屏幕阅读器可读的完整标签描述（无 emoji，含操作提示）。 */
function badgeAriaLabel(analysis: AccountAnalysis | undefined): string {
  const name = analysis?.displayName ?? "该账号";
  if (analysis === undefined) {
    return `${name}：未解析出稳定账号，无法判定`;
  }
  if (analysis.disposition === "whitelisted") {
    return `${name}：白名单账号`;
  }
  if (analysis.disposition === "ignored") {
    return `${name}：已忽略`;
  }
  // AI 结论是唯一判定，读屏软件先听到它。
  if (analysis.review.kind === "ai") {
    const review = analysis.review.review;
    return `${name}：AI 判定营销号概率 ${review.marketingProbability}%，${review.reason}，点击查看依据`;
  }
  if (analysis.review.kind === "triggered") {
    return `${name}：本地注意到值得复核的信号，点击查看具体事实并发起 AI 判定`;
  }
  if (aiUnavailableKeys.has(analysis.accountKey)) {
    return `${name}：AI 判定未取得结论，点击查看`;
  }
  return `${name}：尚无判定，点击查看或发起 AI 判定`;
}

