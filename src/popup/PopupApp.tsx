/**
 * Popup 弹窗页：展示当前页面扫描摘要、适配器诊断，
 * 并提供重新扫描与设置入口。
 */
import { useEffect, useMemo, useState } from "react";
import { sendRuntimeRequest } from "../messaging/protocol";
import type { PageAccountSummary, PageSummary } from "../domain/types";
import { getBlockedAccounts } from "../storage/blocked";

/** 在新标签页打开 UP 主空间页，供人工核实结论后自行处理。 */
function openSpacePage(uid: string): void {
  void chrome.tabs.create({ url: `https://space.bilibili.com/${uid}` });
}

export type BlockBand = "suspicious" | "high";

/** 这一档里可以拉黑的账号：去掉白名单和本地已拉黑。 */
export function blockTargetsForBand(
  accounts: readonly PageAccountSummary[],
  band: BlockBand,
  blockedKeys: ReadonlySet<string>,
): PageAccountSummary[] {
  return accounts.filter((account) => {
    if (account.review.kind !== "ai" || account.disposition === "whitelisted") {
      return false;
    }
    if (blockedKeys.has(account.accountKey)) {
      return false;
    }
    const probability = account.review.review.marketingProbability;
    return band === "high"
      ? probability >= 80
      : probability >= 60 && probability < 80;
  });
}

export function PopupApp(): React.JSX.Element {
  /** 当前页面的扫描摘要；undefined 表示尚未拿到或页面不可扫描。 */
  const [summary, setSummary] = useState<PageSummary>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  /** 诊断信息复制成功的短暂提示状态。 */
  const [copied, setCopied] = useState(false);
  /** 批量判定进度提示。 */
  const [notice, setNotice] = useState<string>();
  /** 批量 AI 判定进行中（避免重复点击）。 */
  const [batchReviewing, setBatchReviewing] = useState(false);
  /** 逐个判定时的进度，例如「判定中 2/10」。 */
  /** 逐个判定时的进度，例如「判定中 2/10」。 */
  const [reviewProgress, setReviewProgress] = useState<string>();
  const [blocking, setBlocking] = useState(false);
  /** 拉黑勾选：默认全选该档可拉黑账号，取消勾选的不拉黑。 */
  const [blockPick, setBlockPick] = useState<{
    band: BlockBand;
    selected: string[];
  } | null>(null);
  const [blockedKeys, setBlockedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  // 已判定按概率再分成两档，分界与徽章颜色一致：60–79、80 以上。
  const counts = useMemo(() => {
    const accounts = summary?.accounts ?? [];
    const probabilityOf = (account: PageAccountSummary): number | undefined =>
      account.review.kind === "ai"
        ? account.review.review.marketingProbability
        : undefined;
    return {
      reviewed: accounts.filter((account) => account.review.kind === "ai").length,
      triggered: accounts.filter(
        (account) => account.review.kind === "triggered",
      ).length,
      unjudged: accounts.filter((account) => account.review.kind === "none").length,
      suspicious: accounts.filter((account) => {
        const probability = probabilityOf(account);
        return probability !== undefined && probability >= 60 && probability < 80;
      }).length,
      high: accounts.filter((account) => {
        const probability = probabilityOf(account);
        return probability !== undefined && probability >= 80;
      }).length,
      blockSuspicious: blockTargetsForBand(accounts, "suspicious", blockedKeys),
      blockHigh: blockTargetsForBand(accounts, "high", blockedKeys),
    };
  }, [summary, blockedKeys]);

  useEffect(() => {
    void refresh(false);
    const onSummary = (message: unknown) => {
      if (!isPageSummaryUpdate(message)) {
        return;
      }
      setSummary(message.summary);
      setError(undefined);
    };
    chrome.runtime.onMessage.addListener(onSummary);
    return () => {
      chrome.runtime.onMessage.removeListener(onSummary);
    };
  }, []);

  useEffect(() => {
    void getBlockedAccounts()
      .then((entries) =>
        setBlockedKeys(new Set(entries.map((entry) => entry.accountKey))),
      )
      .catch(() => setBlockedKeys(new Set()));
  }, [summary]);

  /**
   * 从当前活动标签页的内容脚本读取摘要或触发重扫。
   * @param rescan true 时要求内容脚本重新扫描页面
   */
  async function refresh(rescan: boolean): Promise<void> {
    setLoading(true);
    setError(undefined);
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id === undefined) {
        throw new Error("无法找到当前标签页。");
      }
      const response = (await chrome.tabs.sendMessage(tab.id, {
        scope: "kcf-content",
        type: rescan ? "page.rescan" : "page.summary.get",
      })) as PageSummary;
      setSummary(response);
    } catch {
      // 目标页不是 B 站或内容脚本未注入时都会走到这里。
      setSummary(undefined);
      setError("请先打开受支持的 B 站页面，然后重新扫描。");
    } finally {
      setLoading(false);
    }
  }

  /**
   * 本页尚未有 AI 结论的账号。本地触发器命中的排在前面。
   * 单次最多 10 个，已有结论的不重复提交。
   * 实际发送的是逐条 `ai.review.run`，不是 `ai.review.batch`。
   */
  const reviewCandidates = useMemo(() => {
    const accounts = summary?.accounts ?? [];
    const pending = accounts.filter((account) => account.review.kind !== "ai");
    pending.sort((left, right) =>
      Number(right.review.kind === "triggered") -
      Number(left.review.kind === "triggered"),
    );
    return pending.slice(0, 10);
  }, [summary]);

  /**
   * 逐个判定当前页面尚未有结论的账号。
   *
   * 不把整批塞进一条消息：每个账号最多等 30 秒，10 个串起来时弹窗会
   * 一直停在「判定中」，中间的失败又被后台吞掉，页面控制台看不到。
   * 这里每完成一个就更新进度，失败写到弹窗和控制台。
   */
  async function reviewPageAccounts(): Promise<void> {
    const accounts = reviewCandidates;
    if (accounts.length === 0) {
      setError(
        (summary?.accounts.length ?? 0) === 0
          ? "当前页面没有识别到账号。"
          : "本页账号都已经有 AI 结论。",
      );
      return;
    }
    setBatchReviewing(true);
    setError(undefined);
    const failures: string[] = [];
    let reviewed = 0;
    try {
      for (let index = 0; index < accounts.length; index += 1) {
        const account = accounts[index];
        if (account === undefined) {
          continue;
        }
        const label = account.displayName ?? account.uid;
        setReviewProgress(`判定中 ${index + 1}/${accounts.length}`);
        setNotice(`正在判定 ${index + 1}/${accounts.length}：${label}`);
        try {
          await sendRuntimeRequest("ai.review.run", {
            accountKey: account.accountKey,
          });
          reviewed += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : "判定失败";
          console.error(`[B站内容净化助手] ${label} 判定失败：${message}`);
          failures.push(`${label}：${message}`);
          setError(failures.join("；"));
        }
      }
      setNotice(
        `已判定 ${reviewed} 个账号` +
          (failures.length > 0 ? `，${failures.length} 个失败。` : "。"),
      );
      // 结论写在本地库里。页面徽章用的是内容脚本自己的缓存，
      // 只读摘要不会重绘，必须重扫一次才能把 AI 概率挂上去。
      await refresh(true);
      if (failures.length > 0) {
        setError(failures.join("；"));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "批量判定失败。";
      console.error(`[B站内容净化助手] 批量判定失败：${message}`);
      setNotice(undefined);
      setError(`批量判定失败：${message}`);
    } finally {
      setReviewProgress(undefined);
      setBatchReviewing(false);
    }
  }

  /**
   * 复制适配器诊断 JSON 到剪贴板，便于用户反馈页面改版问题。
   * 内容只含选择器统计，不含标题、UID 或页面地址。
   */
  async function copyDiagnostics(): Promise<void> {
    if (summary === undefined) {
      return;
    }
    // 诊断信息只包含适配器与选择器统计，不含标题、UID 或页面地址。
    const payload = {
      extensionVersion: chrome.runtime.getManifest().version,
      pageKind: summary.pageKind,
      adapterId: summary.adapterId,
      adapterVersion: summary.adapterVersion,
      adapterHealth: summary.adapterHealth,
      diagnostics: summary.diagnostics,
      scannedCards: summary.scannedCards,
      unresolvedCards: summary.unresolvedCards,
      updatedAtMs: summary.updatedAtMs,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setError("复制诊断信息失败。");
    }
  }

  /** 打开某一档的拉黑勾选。已拉黑和白名单不在名单里。 */
  function openBlockPick(band: BlockBand): void {
    const targets = band === "high" ? counts.blockHigh : counts.blockSuspicious;
    if (targets.length === 0 || blocking) {
      return;
    }
    setBlockPick({
      band,
      selected: targets.map((account) => account.accountKey),
    });
  }

  function toggleBlockTarget(accountKey: string): void {
    setBlockPick((current) => {
      if (current === null) {
        return current;
      }
      const selected = current.selected.includes(accountKey)
        ? current.selected.filter((key) => key !== accountKey)
        : [...current.selected, accountKey];
      return { ...current, selected };
    });
  }

  /** 拉黑勾选中的账号。请求发给当前 B 站页面，由内容脚本逐个调用。 */
  async function blockSelected(): Promise<void> {
    if (blockPick === null || blocking) {
      return;
    }
    const pool =
      blockPick.band === "high" ? counts.blockHigh : counts.blockSuspicious;
    const targets = pool.filter((account) =>
      blockPick.selected.includes(account.accountKey),
    );
    if (targets.length === 0) {
      return;
    }
    setBlocking(true);
    setError(undefined);
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id === undefined) {
        throw new Error("无法找到当前标签页。");
      }
      const result = (await chrome.tabs.sendMessage(tab.id, {
        scope: "kcf-content",
        type: "accounts.block",
        accounts: targets.map((account) => ({
          accountKey: account.accountKey,
          uid: account.uid,
          ...(account.displayName === undefined
            ? {}
            : { displayName: account.displayName }),
          ...(account.review.kind === "ai"
            ? { aiProbability: account.review.review.marketingProbability }
            : {}),
        })),
      })) as { blocked: number; failed: number; error?: string };
      if (result.error !== undefined && result.blocked === 0) {
        setError(result.error);
        return;
      }
      setBlockPick(null);
      setNotice(
        result.failed > 0
          ? `已拉黑 ${result.blocked} 个，失败 ${result.failed} 个。`
          : `已拉黑 ${result.blocked} 个。`,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "批量拉黑失败。");
    } finally {
      setBlocking(false);
    }
  }

  return (
    <main className="popup-shell">
      <div className="popup-fixed">
      <header className="popup-header">
        <h1>B站内容净化助手</h1>
        <span className="version">
          v{chrome.runtime.getManifest().version}
        </span>
      </header>

      {loading && summary === undefined ? (
        <p className="scan-meta">正在读取…</p>
      ) : error !== undefined && summary === undefined ? (
        <section className="empty-state" role="alert">
          <strong>当前页面无法扫描</strong>
          <p>{error}</p>
        </section>
      ) : (
        <>
          <p className="scan-meta">
            已扫描 {summary?.scannedCards ?? 0} 个视频
            {(summary?.unresolvedCards ?? 0) > 0
              ? ` · UID 缺失 ${summary?.unresolvedCards} 个`
              : ""}
          </p>
          <section className="summary-grid" aria-label="本页扫描摘要">
            <SummaryCard label="已判定" value={counts.reviewed} />
            <SummaryCard label="待复核" value={counts.triggered} />
            <SummaryCard label="无判定" value={counts.unjudged} />
            <SummaryCard
              label="60–79"
              value={counts.suspicious}
              blockLabel="拉黑本页概率 60–79、尚未拉黑且不在白名单的账号"
              blockDisabled={counts.blockSuspicious.length === 0 || blocking}
              onBlock={() => openBlockPick("suspicious")}
            />
            <SummaryCard
              label="80 以上"
              value={counts.high}
              blockLabel="拉黑本页概率 80 以上、尚未拉黑且不在白名单的账号"
              blockDisabled={counts.blockHigh.length === 0 || blocking}
              onBlock={() => openBlockPick("high")}
            />
          </section>
        </>
      )}

      {notice !== undefined ? (
        <p className="popup-notice" role="status">
          {notice}
        </p>
      ) : null}
      {error !== undefined && summary !== undefined ? (
        <p className="popup-notice" role="alert">
          {error}
        </p>
      ) : null}

      <footer className={summary === undefined ? "popup-actions popup-actions-pair" : "popup-actions"}>
        {summary !== undefined && summary.aiEnabled !== true ? (
          <p className="popup-notice" role="status">
            未配置 AI 时，本页无法判定。
          </p>
        ) : null}
        {summary !== undefined ? (
          <button
            className="button button-primary button-wide"
            type="button"
            disabled={loading || batchReviewing || summary.aiEnabled !== true}
            title={
              summary.aiEnabled === true
                ? reviewCandidates.length > 0
                  ? `对本页 ${reviewCandidates.length} 个尚未判定的账号发起 AI 判定，本地已有信号的优先（单次最多 10 个）`
                  : "本页没有尚未判定的账号"
                : "需在设置页启用并配置 AI 判定后使用"
            }
            onClick={() => void reviewPageAccounts()}
          >
            {batchReviewing
              ? (reviewProgress ?? "判定中…")
              : reviewCandidates.length > 0
                ? `AI 判定本页（${reviewCandidates.length}）`
                : "AI 判定本页"}
          </button>
        ) : null}
        <button
          className={summary === undefined ? "button button-primary button-wide" : "button"}
          type="button"
          disabled={loading}
          onClick={() => void refresh(true)}
        >
          {loading ? "扫描中…" : "重新扫描"}
        </button>
        <button
          className="button"
          type="button"
          onClick={() => void chrome.runtime.openOptionsPage()}
        >
          设置
        </button>
      </footer>
      </div>

      {summary !== undefined && blockPick !== null ? (
        <BlockPick
          band={blockPick.band}
          accounts={
            blockPick.band === "high" ? counts.blockHigh : counts.blockSuspicious
          }
          selected={blockPick.selected}
          busy={blocking}
          onToggle={toggleBlockTarget}
          onConfirm={() => void blockSelected()}
          onCancel={() => setBlockPick(null)}
        />
      ) : null}
      {summary !== undefined && blockPick === null ? (
          <section className="account-list" aria-label="本页账号">
            <div className="section-title">
              <h2>优先查看</h2>
            </div>
            {!loading && summary.adapterHealth === "unsupported" ? (
              <p className="no-accounts">
                当前页面类型暂不支持扫描。请打开 B
                站首页、搜索结果或 UP 主主页后重试。
              </p>
            ) : null}
            {summary.accounts.map((account) => (
              <article
                className="account-row clickable"
                key={account.accountKey}
                role="link"
                tabIndex={0}
                aria-label={`打开 ${account.displayName ?? `UID ${account.uid}`} 的 UP 主主页进行人工核实`}
                title="点击打开 UP 主主页，人工核实后处理"
                onClick={() => void openSpacePage(account.uid)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    void openSpacePage(account.uid);
                  }
                }}
              >
                <div>
                  <strong>{account.displayName ?? `UID ${account.uid}`}</strong>
                  <p>
                    {account.review.kind === "ai"
                      ? account.review.review.reason
                      : account.review.kind === "triggered"
                        ? account.review.triggers[0]?.detail ?? "本地信号提示可复核"
                        : "尚无判定"}
                  </p>
                </div>
                <span className="row-state">
                  {account.review.kind === "ai"
                    ? `${account.review.review.marketingProbability}%`
                    : account.review.kind === "triggered"
                      ? "待复核"
                      : "无判定"}
                </span>
              </article>
            ))}
            {!loading && summary.accounts.length === 0 ? (
              <p className="no-accounts">当前没有可稳定识别 UID 的账号。</p>
            ) : null}
            {summary.adapterHealth !== "healthy" &&
            summary.diagnostics.length > 0 ? (
              <section className="adapter" aria-label="适配器状态">
                <span className={`health health-${summary.adapterHealth}`}>
                  {healthLabel(summary.adapterHealth)}
                </span>
                <button
                  className="copy-button"
                  type="button"
                  onClick={() => void copyDiagnostics()}
                >
                  {copied ? "已复制" : "复制诊断"}
                </button>
                <details className="diagnostics">
                  <summary>选择器诊断（{summary.diagnostics.length}）</summary>
                  <ul>
                    {summary.diagnostics.map((diagnostic) => (
                      <li key={diagnostic.selectorKey}>
                        <code>{diagnostic.selectorKey}</code>
                        <span>{diagnostic.status}</span>
                        {diagnostic.count !== undefined ? (
                          <span>{diagnostic.count}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </details>
              </section>
            ) : null}
          </section>
      ) : null}
    </main>
  );
}

function isPageSummaryUpdate(
  message: unknown,
): message is { summary: PageSummary } {
  return (
    typeof message === "object" &&
    message !== null &&
    "scope" in message &&
    message.scope === "kcf-content" &&
    "type" in message &&
    message.type === "page.summary.updated" &&
    "summary" in message
  );
}

/** 拉黑勾选名单。默认全选，只拉黑仍勾着的账号。 */
function BlockPick(props: {
  band: BlockBand;
  accounts: readonly PageAccountSummary[];
  selected: readonly string[];
  busy: boolean;
  onToggle: (accountKey: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const chosen = props.accounts.filter((account) =>
    props.selected.includes(account.accountKey),
  ).length;
  return (
    <section className="block-pick" aria-label="选择要拉黑的账号">
      <div className="section-title">
        <h2>拉黑 {props.band === "high" ? "80 以上" : "60–79"}</h2>
        <span>已选 {chosen}</span>
      </div>
      <p className="block-pick-note">
        已拉黑和白名单不包含在内。拉黑是平台动作，可在 B 站设置或本插件的「取消拉黑」中撤销。
      </p>
      <div className="block-pick-list">
        {props.accounts.map((account) => {
          const name = account.displayName ?? `UID ${account.uid}`;
          const probability =
            account.review.kind === "ai"
              ? account.review.review.marketingProbability
              : undefined;
          return (
            <label className="block-pick-row" key={account.accountKey}>
              <input
                className="block-pick-input"
                type="checkbox"
                checked={props.selected.includes(account.accountKey)}
                disabled={props.busy}
                onChange={() => props.onToggle(account.accountKey)}
              />
              <span className="block-pick-mark" aria-hidden="true" />
              <span className="block-pick-name">{name}</span>
              {probability !== undefined ? (
                <span className="block-pick-score">{probability}%</span>
              ) : null}
            </label>
          );
        })}
      </div>
      <div className="block-pick-actions">
        <button
          className="button button-destructive"
          type="button"
          disabled={props.busy || chosen === 0}
          onClick={props.onConfirm}
        >
          {props.busy ? "拉黑中…" : `拉黑所选（${chosen}）`}
        </button>
        <button
          className="button"
          type="button"
          disabled={props.busy}
          onClick={props.onCancel}
        >
          取消
        </button>
      </div>
    </section>
  );
}

/** 摘要统计卡片。两档概率卡可以带一个拉黑按钮。 */
function SummaryCard(props: {
  label: string;
  value: number;
  blockLabel?: string;
  blockDisabled?: boolean;
  onBlock?: () => void;
}): React.JSX.Element {
  return (
    <article className="summary-card">
      {props.onBlock !== undefined ? (
        <button
          className="summary-block"
          type="button"
          aria-label={props.blockLabel}
          disabled={props.blockDisabled}
          onClick={props.onBlock}
        >
          <BlockIcon />
        </button>
      ) : null}
      <strong>{props.value}</strong>
      <span>{props.label}</span>
    </article>
  );
}

/** 禁止圈套人，表示拉黑这一档账号。 */
function BlockIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="6.2" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M5.2 11.2c.4-1.5 1.4-2.2 2.8-2.2s2.4.7 2.8 2.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M4 12.2 12.2 3.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 适配器健康度的中文标签。 */
function healthLabel(
  health: PageSummary["adapterHealth"] | undefined,
): string {
  switch (health) {
    case "healthy":
      return "适配正常";
    case "degraded":
      return "适配降级";
    default:
      return "页面不支持";
  }
}
