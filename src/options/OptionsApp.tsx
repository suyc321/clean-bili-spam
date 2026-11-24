/**
 * 设置页：开关、首次使用引导、
 * 三类名单管理（待处理/白名单/忽略）与本地数据导入导出。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  DEFAULT_JUDGMENT_CRITERIA,
  MAX_JUDGMENT_CRITERIA_LENGTH,
} from "../domain/settings";
import type {
  DashboardState,
  ExtensionSettings,
} from "../domain/types";
import { sendRuntimeRequest } from "../messaging/protocol";
import { ACCOUNT_INFO_ORIGIN } from "../api/account-card";
import { EndpointCombo } from "./EndpointCombo";
import { FormatCombo } from "./FormatCombo";
import { ModelCombo } from "./ModelCombo";

const AUDIT_PAGE_SIZE = 20;

/** 点「插入示例」时追加到判定标准末尾，演示怎么改口径（不按观点或立场过滤）。 */
const CRITERIA_EXAMPLE =
  "（标题里出现「全套」「网盘」「提取码」时提高概率；证据不足时仍选 uncertain）";

export function OptionsApp(): React.JSX.Element {
  /** 面板状态（设置 + 名单），undefined 表示尚未加载完成。 */
  const [dashboard, setDashboard] = useState<DashboardState>();
  /** 设置草稿：编辑中的值，点保存后才提交。 */
  const [draft, setDraft] = useState<ExtensionSettings>();
  /** 操作结果提示条文案。 */
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  /** 本次页面上拉到的模型名。不写入设置，关掉页面就丢。 */
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  /** 当前接口域名是否已获浏览器授权（undefined = 未知/未配置）。 */
  const [aiOriginGranted, setAiOriginGranted] = useState<boolean>();
  /** cookies 权限是否已授予（拉黑需要读 bili_jct）。 */
  const [cookieGranted, setCookieGranted] = useState<boolean>();
  const [pane, setPane] = useState<"settings" | "lists">("settings");
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [auditPage, setAuditPage] = useState(0);
  /** 判定标准折叠块：「插入示例」需要强制展开它，所以父组件持有引用。 */
  const criteriaFoldRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    void loadDashboard();
  }, []);

  // 接口地址变化时刷新授权状态显示。
  useEffect(() => {
    const endpoint = dashboard?.settings.aiEndpoint ?? "";
    if (endpoint === "") {
      setAiOriginGranted(undefined);
      return;
    }
    try {
      const origins = [originFromEndpoint(endpoint)];
      void chrome.permissions
        .contains({ origins })
        .then(setAiOriginGranted)
        .catch(() => setAiOriginGranted(undefined));
    } catch {
      setAiOriginGranted(undefined);
    }
  }, [dashboard?.settings.aiEndpoint]);

  // 挂载时检查名片补全的授权状态（api.bilibili.com 主机权限）。
  const [infoGranted, setInfoGranted] = useState<boolean>();
  useEffect(() => {
    void chrome.permissions
      .contains({ origins: [ACCOUNT_INFO_ORIGIN] })
      .then(setInfoGranted);
  }, []);

  /** 申请名片补全所需的主机权限（只读公开数据，不发任何用户数据）。 */
  async function grantAccountInfoPermission(): Promise<void> {
    try {
      const granted = await chrome.permissions.request({
        origins: [ACCOUNT_INFO_ORIGIN],
      });
      setInfoGranted(granted);
      setNotice(
        granted
          ? "已开启公开信息补全，刷新 B 站页面后生效。"
          : "未授权，补全功能保持关闭。",
      );
      if (draft !== undefined) {
        setDraft({ ...draft, enrichAccountInfo: granted });
      }
    } catch (error) {
      setNotice(
        error instanceof Error ? `授权失败：${error.message}` : "授权失败。",
      );
    }
  }

  // 挂载时检查拉黑授权状态（cookies + B 站接口域名，两者都要有）。
  useEffect(() => {
    void Promise.all([
      chrome.permissions.contains({ permissions: ["cookies"] }),
      chrome.permissions.contains({ origins: ["https://api.bilibili.com/*"] }),
    ])
      .then(([cookies, origin]) => setCookieGranted(cookies && origin))
      .catch(() => setCookieGranted(false));
  }, []);

  /**
   * 申请 cookies 权限（拉黑需要读 HttpOnly 的 bili_jct）。
   * 必须在设置页这种有用户手势的页面调用。
   */
  /**
   * 申请拉黑所需的全部权限：cookies（读 HttpOnly 的 bili_jct）
   * 与 api.bilibili.com 主机权限（调用关系接口），一次手势一并授予。
   * 必须在设置页调用——内容脚本没有 chrome.permissions，
   * Service Worker 的 request 没有用户手势会被拒。
   */
  async function grantCookiePermission(): Promise<void> {
    try {
      const granted = await chrome.permissions.request({
        permissions: ["cookies"],
        origins: ["https://api.bilibili.com/*"],
      });
      setCookieGranted(granted);
      setNotice(
        granted
          ? "拉黑授权完成，可以在视频标签上直接拉黑了。"
          : "未授权，拉黑功能不可用。",
      );
    } catch (error) {
      setNotice(
        error instanceof Error ? `授权失败：${error.message}` : "授权失败。",
      );
    }
  }

  /** 从 Service Worker 读取面板状态并填充草稿。 */
  async function loadDashboard(): Promise<void> {
    setBusy(true);
    try {
      const next = await sendRuntimeRequest("dashboard.get", {});
      setDashboard(next);
      setDraft(next.settings);
    } finally {
      setBusy(false);
    }
  }

  /**
   * 保存设置草稿；数值范围由后台归一化。
   *
   * AI 授权流程：开启 AI 时在保存动作中先向浏览器请求接口域名的
   * 主机权限（必须发生在用户手势内），被拒绝则不保存开启状态；
   * 关闭 AI 或更换接口时移除不再需要的授权。
   */
  async function saveSettings(): Promise<void> {
    if (draft === undefined) return;
    setBusy(true);
    try {
      if (draft.aiEnabled) {
        const origins = [originFromEndpoint(draft.aiEndpoint)];
        const granted = await chrome.permissions.request({ origins });
        if (!granted) {
          setNotice("浏览器未授权访问 AI 接口域名，AI 判定保持关闭。");
          const disabled = { ...draft, aiEnabled: false };
          setDraft(disabled);
          await persistSettings(disabled, "设置已保存（AI 判定未开启）。");
          return;
        }
        // 更换接口地址时移除旧域名授权。
        const previousOrigin = tryOriginFromEndpoint(
          dashboard?.settings.aiEndpoint ?? "",
        );
        if (previousOrigin !== undefined && previousOrigin !== origins[0]) {
          await chrome.permissions
            .remove({ origins: [previousOrigin] })
            .catch(() => undefined);
        }
        await persistSettings(draft, "设置已保存。刷新 B 站页面后可立即应用。");
      } else {
        await persistSettings(draft, "设置已保存。刷新 B 站页面后可立即应用。");
        const previousOrigin = tryOriginFromEndpoint(
          dashboard?.settings.aiEndpoint ?? "",
        );
        if (previousOrigin !== undefined) {
          await chrome.permissions
            .remove({ origins: [previousOrigin] })
            .catch(() => undefined);
        }
      }
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "保存失败，请检查输入。",
      );
    } finally {
      setBusy(false);
    }
  }

  /** 把设置草稿写入后台并同步到面板状态。 */
  async function persistSettings(
    next: ExtensionSettings,
    message: string,
  ): Promise<void> {
    const response = await sendRuntimeRequest("settings.patch", {
      patch: next,
    });
    setDraft(response.settings);
    setDashboard((current) =>
      current === undefined
        ? current
        : { ...current, settings: response.settings },
    );
    setNotice(message);
  }

  /** 立刻清掉已保存的判定标准。只改这一项，不把其他未保存的草稿一起写入。 */
  async function restoreDefaultCriteria(): Promise<void> {
    if (draft === undefined) {
      return;
    }
    setBusy(true);
    try {
      const response = await sendRuntimeRequest("settings.patch", {
        patch: { aiJudgmentCriteria: "" },
      });
      setDraft({ ...draft, aiJudgmentCriteria: "" });
      setDashboard((current) =>
        current === undefined
          ? current
          : { ...current, settings: response.settings },
      );
      setNotice("已恢复内置判定标准。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "恢复默认失败。");
    } finally {
      setBusy(false);
    }
  }

  /**
   * 变更账号处置（加入/移出名单）。
   * @param entry 目标账号
   * @param disposition 目标名单
   * @param selected true=加入，false=移出
   */
  async function updateDisposition(
    entry: {
      accountKey: `uid:${string}`;
      uid: string;
      displayName?: string;
    },
    disposition: "whitelisted" | "ignored" | "candidate",
    selected: boolean,
  ): Promise<void> {
    const next = await sendRuntimeRequest("account.disposition", {
      ...entry,
      disposition,
      selected,
    });
    setDashboard(next);
    setNotice("名单已更新。");
  }

  /** 关闭首次使用引导（写入设置，之后不再显示）。 */
  async function dismissOnboarding(): Promise<void> {
    setBusy(true);
    try {
      const response = await sendRuntimeRequest("settings.patch", {
        patch: { showOnboarding: false },
      });
      setDraft(response.settings);
      setDashboard((current) =>
        current === undefined
          ? current
          : { ...current, settings: response.settings },
      );
    } finally {
      setBusy(false);
    }
  }

  /** 导出配置文件（不含投稿观察记录）。 */
  async function exportSettings(): Promise<void> {
    const { bundle } = await sendRuntimeRequest("export.create", {});
    downloadJson(bundle, exportFileName());
    setNotice("配置、白名单和待处理清单已导出。");
  }

  /**
   * 从文件导入配置：解析失败或结构非法时展示错误提示。
   * @param file 用户选择的 JSON 文件
   */
  async function importSettings(file: File): Promise<void> {
    setBusy(true);
    try {
      const bundle = JSON.parse(await file.text()) as unknown;
      const next = await sendRuntimeRequest("import.commit", { bundle });
      setDashboard(next);
      setDraft(next.settings);
      setNotice("导入完成。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "导入失败。");
    } finally {
      setBusy(false);
    }
  }

  /** 只清空判定日志，不碰结论、设置和名单。 */
  async function clearAuditLog(): Promise<void> {
    if (!window.confirm("确定清空全部判定记录吗？这只删除日志，不影响已有判定和设置。")) {
      return;
    }
    const next = await sendRuntimeRequest("audit.clear", {});
    setAuditPage(0);
    setDashboard(next);
    setNotice("判定记录已清空。");
  }

  /** 清空观察账号和缓存结论。设置、名单和判定日志保留。 */
  async function clearObservations(): Promise<void> {
    if (
      !window.confirm(
        "确定清除观察记录吗？账号和投稿标题会被删掉，已缓存的 AI 结论也会失效。设置和名单会保留。",
      )
    ) {
      return;
    }
    const next = await sendRuntimeRequest("observations.clear", {});
    setDashboard(next);
    setNotice("观察记录已清除。");
  }

  /** 重置插件：设置、名单、观察记录、判定日志和拉黑记录一起清空。 */
  async function resetData(): Promise<void> {
    if (
      !window.confirm(
        "确定重置插件吗？观察记录、判定记录、拉黑记录、白名单、待处理、忽略和设置都会清除。",
      )
    ) {
      return;
    }
    const next = await sendRuntimeRequest("data.reset", {});
    setDashboard(next);
    setDraft(next.settings);
    setNotice("本地数据已清除。");
  }

  /**
   * 导出全部观察数据（含标题与简介等敏感字段）。
   * 与配置导出不同，这里必须让用户显式确认后才执行。
   */
  async function exportObservations(): Promise<void> {
    if (
      !window.confirm(
        "观察数据包含账号昵称、简介与投稿标题等敏感内容，确定导出为 JSON 文件吗？",
      )
    ) {
      return;
    }
    const { bundle } = await sendRuntimeRequest("observation.export", {});
    downloadJson(
      bundle,
      `clean-bili-spam-observations-${new Date()
        .toISOString()
        .slice(0, 10)}.json`,
    );
    setNotice("观察数据已导出。请妥善保管，避免分享给他人。");
  }

  /**
   * 测试 AI 接口连通性：使用设置页当前的草稿配置（无需先保存），
   * 便于「填好→测通→再保存」。新域名会在点击手势内先请求授权。
   */
  async function testAiConnection(): Promise<void> {
    if (draft === undefined) return;
    setBusy(true);
    try {
      const origins = [originFromEndpoint(draft.aiEndpoint)];
      const granted = await chrome.permissions.contains({ origins });
      if (!granted) {
        const requested = await chrome.permissions.request({ origins });
        if (!requested) {
          setNotice("浏览器未授权访问该接口域名，无法测试。");
          return;
        }
      }
      const { model } = await sendRuntimeRequest("ai.config.test", {
        config: {
          aiEndpoint: draft.aiEndpoint,
          aiApiKey: draft.aiApiKey,
          aiModel: draft.aiModel,
          // 草稿格式一起带上：不传的话测的是另一种格式，「测通」不算数
          aiFormat: draft.aiFormat,
        },
      });
      setAiOriginGranted(true);
      setNotice(`AI 接口连接正常（模型：${model}）。`);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "AI 接口连接失败。",
      );
    } finally {
      setBusy(false);
    }
  }

  /** 用当前草稿的地址和密钥拉模型目录。不要求已经填模型名。 */
  async function loadModelList(): Promise<void> {
    if (draft === undefined) {
      return;
    }
    setBusy(true);
    try {
      const origins = [originFromEndpoint(draft.aiEndpoint)];
      const granted = await chrome.permissions.contains({ origins });
      if (!granted) {
        const requested = await chrome.permissions.request({ origins });
        if (!requested) {
          setNotice("浏览器未授权访问该接口域名，无法获取模型列表。");
          return;
        }
      }
      const { models } = await sendRuntimeRequest("ai.models.list", {
        aiEndpoint: draft.aiEndpoint,
        aiApiKey: draft.aiApiKey,
        aiFormat: draft.aiFormat,
      });
      setModelOptions(models);
      setAiOriginGranted(true);
      setNotice(`已获取 ${models.length} 个模型。`);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "获取模型列表失败。",
      );
    } finally {
      setBusy(false);
    }
  }

  // 数据未加载完成时显示读取中状态。
  if (dashboard === undefined || draft === undefined) {
    return <main className="options-shell options-shell-loading">正在读取本地设置…</main>;
  }

  const auditCount = dashboard.aiAudit.length;
  const auditPageCount = Math.max(1, Math.ceil(auditCount / AUDIT_PAGE_SIZE));
  const auditPageIndex = Math.min(auditPage, auditPageCount - 1);

  return (
    <main className="options-shell">
      <div className="settings-frame">
        <header className="settings-top">
          <div>
            <h1>B站内容净化助手</h1>
            <p>只分析已经打开的页面。概率是模型判断。</p>
          </div>
          <button
            className="button primary"
            type="button"
            disabled={busy}
            onClick={() => void saveSettings()}
          >
            保存
          </button>
        </header>

        <nav className="settings-nav" aria-label="设置分类">
          {(
            [
              ["settings", "设置"],
              ["lists", "名单"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-current={pane === id ? "page" : undefined}
              onClick={() => setPane(id)}
            >
              {label}
            </button>
          ))}
        </nav>

        {notice !== undefined ? (
          <div className="notice" role="status">
            {notice}
          </div>
        ) : null}

        <div className="settings-pane">
            {pane === "settings" ? (
              <>
                {dashboard.settings.showOnboarding ? (
                  <section className="group" id="start" aria-label="使用引导">
                    <p className="group-label">开始使用</p>
                    <div className="group-card">
                      <div className="setting-row">
                        <div className="setting-copy">
                          <h2>三件事先知道</h2>
                          <p>未配置 AI 时，卡片徽章显示「无判定」。</p>
                          <p>插件不会自动拉黑。</p>
                          <p>观察记录只保存在本机。</p>
                        </div>
                        <button
                          className="button"
                          type="button"
                          onClick={() => void dismissOnboarding()}
                        >
                          知道了
                        </button>
                      </div>
                    </div>
                  </section>
                ) : null}

                <div className="settings-columns">
                <div className="settings-column">
                <section className="group" id="retention">
                  <p className="group-label">页面</p>
                  <div className="group-card">
                    <div className="setting-row">
                      <div className="setting-copy">
                        <h2>显示标签</h2>
                        <p>在支持的 B 站页面上显示判定。</p>
                      </div>
                      <Toggle
                        checked={draft.showBadges}
                        label="显示标签"
                        onChange={(checked) =>
                          setDraft({ ...draft, showBadges: checked })
                        }
                      />
                    </div>
                    <div className="setting-row">
                      <div className="setting-copy">
                        <h2>弱化高概率卡片</h2>
                        <p>AI 概率达到 80 时盖住卡片，默认关闭。</p>
                      </div>
                      <Toggle
                        checked={draft.automaticallyDimHighRisk}
                        label="弱化高概率卡片"
                        onChange={(checked) =>
                          setDraft({
                            ...draft,
                            automaticallyDimHighRisk: checked,
                          })
                        }
                      />
                    </div>
                    <div className="setting-row">
                      <div className="setting-copy">
                        <h2>广告和强插</h2>
                        <p>
                          首页推荐里没有投稿链接的卡片，可遮挡或直接从页面隐藏。
                        </p>
                      </div>
                      <div className="seg" role="group" aria-label="广告和强插处理">
                        {(
                          [
                            ["off", "不处理"],
                            ["cover", "遮挡"],
                            ["remove", "直接隐藏"],
                          ] as const
                        ).map(([mode, label]) => (
                          <button
                            key={mode}
                            type="button"
                            aria-pressed={draft.feedAdMode === mode}
                            onClick={() =>
                              setDraft({ ...draft, feedAdMode: mode })
                            }
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="setting-row">
                      <div className="setting-copy">
                        <h2>遮罩颜色</h2>
                        <p>
                          广告遮挡与高概率弱化共用。选择后不再跟随系统深色模式。
                        </p>
                      </div>
                      <div className="seg" role="group" aria-label="遮罩颜色">
                        {(
                          [
                            ["dark", "纯黑"],
                            ["light", "纯白"],
                            ["gray", "灰色"],
                          ] as const
                        ).map(([color, label]) => (
                          <button
                            key={color}
                            type="button"
                            aria-pressed={draft.coverColor === color}
                            onClick={() =>
                              setDraft({ ...draft, coverColor: color })
                            }
                          >
                            <span
                              className={`swatch swatch-${color}`}
                              aria-hidden="true"
                            />
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </section>

                <section className="group">
                  <p className="group-label">保留</p>
                  <div className="group-card">
                    <div className="settings-grid">
                      <label className="field">
                        <span>每个账号最多保留投稿</span>
                        <input
                          type="number"
                          min={5}
                          max={50}
                          value={draft.maxVideosPerAccount}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              maxVideosPerAccount: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>观察数据保留天数</span>
                        <input
                          type="number"
                          min={7}
                          max={365}
                          value={draft.retentionDays}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              retentionDays: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                    </div>
                  </div>
                </section>
                <section className="group" id="block-auth">
                  <p className="group-label">拉黑</p>
                  <div className="group-card">
                    <div className="setting-row">
                      <div className="setting-copy">
                        <h2>拉黑授权</h2>
                        <p>读取本机登录凭证，只在拉黑时使用。</p>
                      </div>
                      <button
                        className="button"
                        type="button"
                        disabled={cookieGranted === true || busy}
                        onClick={() => void grantCookiePermission()}
                      >
                        {cookieGranted === true ? "已授权" : "授权"}
                      </button>
                    </div>
                  </div>
                </section>
                <section className="group" id="enrich">
                  <p className="group-label">公开信息</p>
                  <div className="group-card">
                    <div className="setting-row">
                      <div className="setting-copy">
                        <h2>补全简介和粉丝数</h2>
                        <p>首页卡片没有简介。开启后读取公开名片。</p>
                      </div>
                      <button
                        className="button"
                        type="button"
                        disabled={infoGranted === true || busy}
                        onClick={() => void grantAccountInfoPermission()}
                      >
                        {infoGranted === true ? "已授权" : "授权"}
                      </button>
                    </div>
                    <div className="setting-row">
                      <div className="setting-copy">
                        <h2>扫描时补全</h2>
                        <p>需要先完成上面的授权。</p>
                      </div>
                      <Toggle
                        checked={draft.enrichAccountInfo === true}
                        label="扫描时补全"
                        onChange={(checked) =>
                          setDraft({ ...draft, enrichAccountInfo: checked })
                        }
                      />
                    </div>
                  </div>
                </section>
                </div>
                <div className="settings-column">
                <section className="group" id="ai">
                  <p className="group-label">AI 判定</p>
                  <div className="group-card">
                    <div className="setting-row">
                      <div className="setting-copy">
                        <h2>启用 AI 判定</h2>
                        <p>未配置时，卡片徽章显示「无判定」。</p>
                        <p>
                          启用后，账号的昵称、简介、最多 20 条投稿标题和发布时间会发送到你填写的接口
                          （开启「扫描时补全」后还会带上粉丝数和投稿数），不含 UID、Cookie 和浏览历史。
                          接口由你自己选择，数据如何处理取决于该服务商。
                        </p>
                      </div>
                      <Toggle
                        checked={draft.aiEnabled}
                        label="启用 AI 判定"
                        onChange={(checked) =>
                          setDraft({ ...draft, aiEnabled: checked })
                        }
                      />
                    </div>
                    <div className="settings-grid ai-grid">
                      <div className="field field-wide">
                        <span>接口地址</span>
                        <EndpointCombo
                          value={draft.aiEndpoint}
                          onValueChange={(value) =>
                            setDraft({ ...draft, aiEndpoint: value })
                          }
                          onPreset={(preset) =>
                            setDraft({
                              ...draft,
                              aiEndpoint: preset.endpoint,
                              aiFormat: preset.format,
                            })
                          }
                        />
                      </div>
                      <div className="field">
                        <span>API Key</span>
                        <div className="secret-field">
                          <input
                            type={apiKeyVisible ? "text" : "password"}
                            placeholder="只保存在本机"
                            autoComplete="off"
                            value={draft.aiApiKey}
                            onChange={(event) =>
                              setDraft({ ...draft, aiApiKey: event.target.value })
                            }
                          />
                          <button
                            className="secret-toggle"
                            type="button"
                            aria-pressed={apiKeyVisible}
                            aria-label={apiKeyVisible ? "隐藏 API Key" : "查看 API Key"}
                            onClick={() => setApiKeyVisible((current) => !current)}
                          />
                        </div>
                      </div>
                      <div className="field">
                        <span>模型名称</span>
                        <ModelCombo
                          value={draft.aiModel}
                          options={modelOptions}
                          onValueChange={(value) =>
                            setDraft({ ...draft, aiModel: value })
                          }
                        />
                      </div>
                      <label className="field field-wide">
                        <span>接口格式</span>
                        <FormatCombo
                          value={draft.aiFormat}
                          onValueChange={(value) =>
                            setDraft({ ...draft, aiFormat: value })
                          }
                        />
                        <span className="field-hint">
                          地址填到 /v1，路径会按格式补上。
                        </span>
                      </label>
                    </div>
                    <FoldCard
                      title="判定标准"
                      defaultOpen={false}
                      foldRef={criteriaFoldRef}
                      tools={
                        <>
                          <button
                            className="button"
                            type="button"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={(event) => {
                              event.preventDefault();
                              const current =
                                draft.aiJudgmentCriteria === ""
                                  ? DEFAULT_JUDGMENT_CRITERIA
                                  : draft.aiJudgmentCriteria;
                              if (
                                !current.includes(CRITERIA_EXAMPLE) &&
                                current.length + CRITERIA_EXAMPLE.length <=
                                  MAX_JUDGMENT_CRITERIA_LENGTH
                              ) {
                                setDraft({
                                  ...draft,
                                  aiJudgmentCriteria: `${current}${CRITERIA_EXAMPLE}`,
                                });
                              }
                              const fold = criteriaFoldRef.current;
                              if (fold !== null && !fold.open) {
                                fold.open = true;
                              }
                            }}
                          >
                            插入示例
                          </button>
                          <button
                            className="button"
                            type="button"
                            disabled={busy}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={(event) => {
                              event.preventDefault();
                              void restoreDefaultCriteria();
                            }}
                          >
                            恢复默认
                          </button>
                        </>
                      }
                    >
                      <div className="field">
                        <textarea
                          maxLength={MAX_JUDGMENT_CRITERIA_LENGTH}
                          value={
                            draft.aiJudgmentCriteria === ""
                              ? DEFAULT_JUDGMENT_CRITERIA
                              : draft.aiJudgmentCriteria
                          }
                          onChange={(event) => {
                            const next = event.target.value;
                            setDraft({
                              ...draft,
                              aiJudgmentCriteria:
                                next === DEFAULT_JUDGMENT_CRITERIA ? "" : next,
                            });
                          }}
                        />
                        <span className="field-hint">
                          可以改写成你自己的判断尺度。保存后，这段文字会发给你配置的 AI。
                        </span>
                      </div>
                    </FoldCard>
                    <div className="data-actions">
                      <p className="ai-grant-state">
                        {draft.aiEndpoint === ""
                          ? "还没有接口地址"
                          : aiOriginGranted === true
                            ? "域名已授权"
                            : "保存时申请域名授权"}
                      </p>
                      <button
                        className="button"
                        type="button"
                        disabled={
                          busy ||
                          draft.aiEndpoint.trim() === "" ||
                          draft.aiApiKey.trim() === "" ||
                          draft.aiModel.trim() === ""
                        }
                        onClick={() => void testAiConnection()}
                      >
                        测试连接
                      </button>
                      <button
                        className="button"
                        type="button"
                        disabled={
                          busy ||
                          draft.aiEndpoint.trim() === "" ||
                          draft.aiApiKey.trim() === ""
                        }
                        onClick={() => void loadModelList()}
                      >
                        获取模型列表
                      </button>
                    </div>
                    <div className="setting-row">
                      <div className="setting-copy">
                        <h2>打印对话</h2>
                        <p>在后台控制台打印发给模型的内容和模型的回复，仅用于排查问题。默认关闭。</p>
                      </div>
                      <Toggle
                        checked={draft.logAiExchange}
                        label="打印对话"
                        onChange={(checked) =>
                          setDraft({ ...draft, logAiExchange: checked })
                        }
                      />
                    </div>
                    <FoldCard
                      title="判定记录"
                      count={dashboard.aiAudit.length}
                      defaultOpen={false}
                      onToggle={(open) => {
                        if (!open) {
                          setAuditPage(0);
                        }
                      }}
                      tools={
                        <>
                          {auditCount > AUDIT_PAGE_SIZE ? (
                          <span className="audit-pager">
                            <button
                              className="button"
                              type="button"
                              disabled={auditPageIndex === 0}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={(event) => {
                                event.preventDefault();
                                setAuditPage(auditPageIndex - 1);
                              }}
                            >
                              上一页
                            </button>
                            <span>
                              {auditPageIndex + 1} / {auditPageCount}
                            </span>
                            <button
                              className="button"
                              type="button"
                              disabled={
                                (auditPageIndex + 1) * AUDIT_PAGE_SIZE >= auditCount
                              }
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={(event) => {
                                event.preventDefault();
                                setAuditPage(auditPageIndex + 1);
                              }}
                            >
                              下一页
                            </button>
                          </span>
                          ) : null}
                          {auditCount > 0 ? (
                            <button
                              className="button"
                              type="button"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={(event) => {
                                event.preventDefault();
                                void clearAuditLog();
                              }}
                            >
                              清空
                            </button>
                          ) : null}
                        </>
                      }
                    >
                      <div className="audit-list">
                        {dashboard.aiAudit
                          .slice(
                            auditPageIndex * AUDIT_PAGE_SIZE,
                            auditPageIndex * AUDIT_PAGE_SIZE + AUDIT_PAGE_SIZE,
                          )
                          .map((entry) => {
                            const seen = new Date(entry.createdAtMs);
                            const time = `${seen.getMonth() + 1}/${seen.getDate()} ${String(seen.getHours()).padStart(2, "0")}:${String(seen.getMinutes()).padStart(2, "0")}`;
                            return (
                              <div className="audit-row" key={entry.id}>
                                <span className="audit-time">{time}</span>
                                <span className="audit-name">
                                  {entry.displayName ?? `UID ${entry.uid}`}
                                </span>
                                <span
                                  className="audit-result"
                                  title={
                                    entry.outcome === "success"
                                      ? undefined
                                      : entry.errorMessage
                                  }
                                >
                                  {entry.outcome === "success"
                                    ? `${entry.marketingProbability ?? "?"}%`
                                    : "失败"}
                                </span>
                              </div>
                            );
                          })}
                        {auditCount === 0 ? (
                          <p className="audit-empty">还没有判定记录。</p>
                        ) : null}
                      </div>
                    </FoldCard>
                  </div>
                </section>
                </div>
                </div>
              </>
            ) : null}

            {pane === "lists" ? (
              <>
                <NameList
                  id="candidates"
                  title="待处理"
                  count={dashboard.candidates.length}
                  empty="还没有待处理账号。"
                >
                  {dashboard.candidates
                    .slice()
                    .sort((left, right) => right.addedAtMs - left.addedAtMs)
                    .map((entry) => (
                      <article className="list-row" key={entry.accountKey}>
                        <div>
                          <strong>{entry.displayName ?? `UID ${entry.uid}`}</strong>
                          <p>
                            {entry.aiProbability === undefined
                              ? "加入时没有 AI 结论"
                              : `加入时 ${entry.aiProbability}%`}
                          </p>
                        </div>
                        <div className="row-actions">
                          <button
                            className="button"
                            type="button"
                            onClick={() =>
                              void updateDisposition(entry, "whitelisted", true)
                            }
                          >
                            移入白名单
                          </button>
                          <button
                            className="button"
                            type="button"
                            onClick={() =>
                              void chrome.tabs.create({
                                url: `https://space.bilibili.com/${entry.uid}`,
                              })
                            }
                          >
                            打开主页
                          </button>
                          <button
                            className="button danger"
                            type="button"
                            onClick={() =>
                              void updateDisposition(entry, "candidate", false)
                            }
                          >
                            移除
                          </button>
                        </div>
                      </article>
                    ))}
                </NameList>
                <NameList
                  id="whitelist"
                  title="白名单"
                  count={dashboard.whitelist.length}
                  empty="还没有白名单账号。"
                >
                  {dashboard.whitelist.map((entry) => {
                    const uid = entry.accountKey.slice(4);
                    return (
                      <article className="list-row" key={entry.accountKey}>
                        <div>
                          <strong>{entry.displayName ?? `UID ${uid}`}</strong>
                          <p>UID {uid}</p>
                        </div>
                        <div className="row-actions">
                          <button
                            className="button"
                            type="button"
                            onClick={() =>
                              void chrome.tabs.create({
                                url: `https://space.bilibili.com/${uid}`,
                              })
                            }
                          >
                            打开主页
                          </button>
                          <button
                            className="button danger"
                            type="button"
                            onClick={() =>
                              void updateDisposition(
                                {
                                  accountKey: entry.accountKey,
                                  uid,
                                  ...(entry.displayName === undefined
                                    ? {}
                                    : { displayName: entry.displayName }),
                                },
                                "whitelisted",
                                false,
                              )
                            }
                          >
                            移除
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </NameList>
                <NameList
                  id="ignored"
                  title="忽略"
                  count={dashboard.ignored.length}
                  empty="还没有忽略的账号。"
                >
                  {dashboard.ignored.map((entry) => {
                    const uid = entry.accountKey.slice(4);
                    return (
                      <article className="list-row" key={entry.accountKey}>
                        <div>
                          <strong>{entry.displayName ?? `UID ${uid}`}</strong>
                          <p>UID {uid}</p>
                        </div>
                        <div className="row-actions">
                          <button
                            className="button"
                            type="button"
                            onClick={() =>
                              void chrome.tabs.create({
                                url: `https://space.bilibili.com/${uid}`,
                              })
                            }
                          >
                            打开主页
                          </button>
                          <button
                            className="button danger"
                            type="button"
                            onClick={() =>
                              void updateDisposition(
                                {
                                  accountKey: entry.accountKey,
                                  uid,
                                  ...(entry.displayName === undefined
                                    ? {}
                                    : { displayName: entry.displayName }),
                                },
                                "ignored",
                                false,
                              )
                            }
                          >
                            恢复
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </NameList>
                <NameList
                  id="block-log"
                  title="拉黑记录"
                  count={dashboard.blockedAccounts.length}
                  empty="还没有拉黑记录。"
                >
                  {dashboard.blockedAccounts.map((entry) => (
                    <article className="list-row" key={entry.accountKey}>
                      <div>
                        <strong>{entry.displayName ?? `UID ${entry.uid}`}</strong>
                        <p>
                          {new Date(entry.blockedAtMs).toLocaleString("zh-CN")}
                        </p>
                      </div>
                      <div className="row-actions">
                        <button
                          className="button"
                          type="button"
                          onClick={() =>
                            void chrome.tabs.create({
                              url: `https://space.bilibili.com/${entry.uid}`,
                            })
                          }
                        >
                          打开主页
                        </button>
                      </div>
                    </article>
                  ))}
                </NameList>
                <section className="group" id="data-export">
                  <p className="group-label">数据</p>
                  <div className="group-card">
                    <div className="setting-row">
                      <div className="setting-copy">
                        <h2>导入导出</h2>
                        <p>已观察 {dashboard.observedAccountCount} 个账号。</p>
                      </div>
                    </div>
                    <div className="data-actions">
                      <button
                        className="button"
                        type="button"
                        onClick={() => void exportSettings()}
                      >
                        导出配置
                      </button>
                      <button
                        className="button"
                        type="button"
                        onClick={() => void exportObservations()}
                      >
                        导出观察数据
                      </button>
                      <label className="button file-button">
                        导入配置
                        <input
                          type="file"
                          accept="application/json,.json"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file !== undefined) void importSettings(file);
                            event.target.value = "";
                          }}
                        />
                      </label>
                      <button
                        className="button warning action-split"
                        type="button"
                        disabled={dashboard.observedAccountCount === 0}
                        onClick={() => void clearObservations()}
                      >
                        清除观察记录
                      </button>
                      <button
                        className="button danger"
                        type="button"
                        onClick={() => void resetData()}
                      >
                        重置插件
                      </button>
                    </div>
                  </div>
                </section>
              </>
            ) : null}
          </div>
      </div>
    </main>
  );
}

function NameList(props: {
  id: string;
  title: string;
  count: number;
  empty: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <section className="group" id={props.id}>
      <div className="group-card list">
        <FoldCard title={props.title} count={props.count} defaultOpen listBody>
          {props.count === 0 ? (
            <p className="empty">{props.empty}</p>
          ) : (
            props.children
          )}
        </FoldCard>
      </div>
    </section>
  );
}

/**
 * 折叠卡片：标题（三角箭头 + 可选计数）在卡片内，右侧工具区，
 * 内容可折叠。判定标准、判定记录与名单页四个列表共用这一套，
 * 视觉和交互（含 summary 内按钮的防误触）只有一份实现。
 */
function FoldCard(props: {
  title: string;
  count?: number;
  /** 默认展开（名单列表）；判定标准与判定记录传 false 保持原样。 */
  defaultOpen: boolean;
  /** 内容是多行列表时传 true：去掉折叠块自身留白，分隔交给行的边框。 */
  listBody?: boolean;
  /** 工具区按钮，渲染在展开/折叠按钮左边。 */
  tools?: ReactNode;
  /** 父组件需要强制展开时持有这个引用（如「插入示例」）。 */
  foldRef?: React.RefObject<HTMLDetailsElement | null>;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(props.defaultOpen);
  const innerRef = useRef<HTMLDetailsElement>(null);
  const ref = props.foldRef ?? innerRef;
  return (
    <details
      className={props.listBody === true ? "audit-fold fold-list" : "audit-fold"}
      ref={ref}
      open={props.defaultOpen}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        props.onToggle?.(event.currentTarget.open);
      }}
    >
      <summary>
        <span className="audit-label">
          {props.title}
          {props.count === undefined ? "" : `（${props.count}）`}
        </span>
        <span className="audit-tools">
          {props.tools}
          <button
            className="button"
            type="button"
            aria-expanded={open}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.preventDefault();
              const fold = ref.current;
              if (fold !== null) {
                // 同步本地状态：details 的 toggle 事件是异步合并派发的，
                // 不等它，按钮文案立刻跟上（jsdom 根本不派发该事件）。
                const next = !fold.open;
                fold.open = next;
                setOpen(next);
              }
            }}
          >
            {open ? "折叠" : "展开"}
          </button>
        </span>
      </summary>
      {props.children}
    </details>
  );
}


/**
 * 接口地址对应的主机权限匹配模式（形如 `https://host/*`）。
 * 只接受 https：manifest 的可选主机权限只声明了 https 通配，http 地址申请不到授权。
 */
function originFromEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint.trim());
  } catch {
    throw new Error("接口地址不是有效的链接。");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("接口地址必须是 https 链接。");
  }
  return `${parsed.origin}/*`;
}

/** 同 originFromEndpoint，但地址为空或不合法时返回 undefined（用于清理旧授权）。 */
function tryOriginFromEndpoint(endpoint: string): string | undefined {
  if (endpoint.trim() === "") {
    return undefined;
  }
  try {
    return originFromEndpoint(endpoint);
  } catch {
    return undefined;
  }
}

/** 开关行组件。 */
function Toggle(props: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <label className="toggle">
      <span>{props.label}</span>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span className="switch" aria-hidden="true" />
    </label>
  );
}

/** 配置导出文件名（带日期）。 */
function exportFileName(): string {
  return `clean-bili-spam-${new Date().toISOString().slice(0, 10)}.json`;
}

/** 把任意 JSON 结构下载为文件。 */
function downloadJson(data: unknown, fileName: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
