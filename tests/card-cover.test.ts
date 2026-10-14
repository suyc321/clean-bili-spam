// 共享卡片遮罩：两种 kind 共存、inert 点击封锁与豁免、隐藏与恢复。
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureCardCover,
  removeCardCover,
  setCardHidden,
} from "../src/content/card-cover";

function makeCard(html = "<div class='inner'><a href='/video/BV1'>视频</a></div>") {
  const card = document.createElement("div");
  card.className = "bili-video-card";
  card.innerHTML = html;
  document.body.append(card);
  return card;
}

describe("共享卡片遮罩", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("挂遮罩并写入标签与颜色；参数不变时复用同一宿主", () => {
    const card = makeCard();
    ensureCardCover(card, { kind: "ad", color: "dark", label: "已遮挡广告" });
    const host = card.querySelector<HTMLElement>(".kcf-card-cover")!;
    expect(host.dataset.kind).toBe("ad");
    expect(host.dataset.color).toBe("dark");
    expect(host.shadowRoot?.textContent).toContain("已遮挡广告");

    ensureCardCover(card, { kind: "ad", color: "dark", label: "已遮挡广告" });
    expect(card.querySelectorAll(".kcf-card-cover")).toHaveLength(1);
    expect(card.querySelector(".kcf-card-cover")).toBe(host);
  });

  it("同一卡片可同时挂广告与弱化两个遮罩，拆一个不影响另一个", () => {
    const card = makeCard();
    ensureCardCover(card, { kind: "ad", color: "dark", label: "已遮挡广告" });
    ensureCardCover(card, { kind: "dim", color: "dark", label: "已弱化" });
    expect(card.querySelectorAll(".kcf-card-cover")).toHaveLength(2);

    removeCardCover(card, "ad");
    expect(card.querySelectorAll(".kcf-card-cover")).toHaveLength(1);
    expect(
      card.querySelector<HTMLElement>(".kcf-card-cover")?.dataset.kind,
    ).toBe("dim");
  });

  it("挂遮罩时卡片内容 inert，徽章宿主豁免", () => {
    const card = makeCard();
    const badgeHost = document.createElement("div");
    badgeHost.className = "kcf-badge-host";
    card.append(badgeHost);

    ensureCardCover(card, { kind: "dim", color: "gray", label: "已弱化" });
    const inner = card.querySelector(".inner")!;
    expect(inner.hasAttribute("inert")).toBe(true);
    expect(badgeHost.hasAttribute("inert")).toBe(false);

    removeCardCover(card, "dim");
    expect(inner.hasAttribute("inert")).toBe(false);
  });

  it("两个遮罩共存时拆掉一个，inert 保持到全部拆完", () => {
    const card = makeCard();
    ensureCardCover(card, { kind: "ad", color: "dark", label: "已遮挡广告" });
    ensureCardCover(card, { kind: "dim", color: "dark", label: "已弱化" });
    const inner = card.querySelector(".inner")!;

    removeCardCover(card, "ad");
    expect(inner.hasAttribute("inert")).toBe(true);
    removeCardCover(card, "dim");
    expect(inner.hasAttribute("inert")).toBe(false);
  });

  it("不碰页面自己加的 inert", () => {
    const card = makeCard();
    const inner = card.querySelector(".inner")!;
    inner.setAttribute("inert", "");

    ensureCardCover(card, { kind: "ad", color: "dark", label: "已遮挡广告" });
    removeCardCover(card, "ad");
    // 没有我们的记号，不能替页面拆掉它自己挂的 inert。
    expect(inner.hasAttribute("inert")).toBe(true);
  });

  it("setCardHidden 只恢复自己藏过的卡片", () => {
    const card = makeCard();
    const alreadyHidden = makeCard();
    alreadyHidden.style.display = "none";

    setCardHidden(card, true);
    expect(card.style.display).toBe("none");

    setCardHidden(card, false);
    expect(card.style.display).toBe("");

    // 不是我们藏的：restore 不能把页面原有的 display:none 抹掉。
    setCardHidden(alreadyHidden, false);
    expect(alreadyHidden.style.display).toBe("none");
  });
});
