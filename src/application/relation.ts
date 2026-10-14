/**
 * 拉黑所需的登录凭证读取。
 *
 * 拉黑请求本身在页面上下文里由内容脚本发出（Service Worker 里发会被 B 站 412 拒绝），
 * Service Worker 只负责读取 HttpOnly 的 `bili_jct`，因为内容脚本读不到它。
 * 权限：`cookies` 是可选权限，在设置页的「拉黑授权」里由用户主动授予。
 */

/**
 * 读取 B 站 CSRF 令牌（bili_jct）的结果。
 *
 * 之所以不返回裸字符串：把「没授权」「没登录」「cookie 为空」坍缩成同一个空串，
 * 界面只能提示「请刷新 B 站页面后重试」，而真实原因往往是权限没授予或没登录。
 * 显式区分后，界面能给出可操作的说法。
 */
export type CsrfReadResult =
  | { status: "ok"; csrf: string }
  | { status: "no-permission" }
  | { status: "no-cookie" };

/** CSRF 失败原因（用于消息载荷，界面据此选择提示文案）。 */
export type CsrfFailureReason = Exclude<CsrfReadResult["status"], "ok">;

/**
 * 把 CSRF 失败原因翻译成面向用户的中文说明。
 * Service Worker 用例与内容脚本共用同一份文案，避免两处说法不一致。
 */
export function describeCsrfFailure(reason: CsrfFailureReason): string {
  switch (reason) {
    case "no-permission":
      return "尚未获得读取 B 站登录凭证的授权。请在插件设置页「拉黑授权」中点击「授权 B 站登录状态」后重试。";
    case "no-cookie":
      return "未检测到 B 站登录状态（bili_jct）。请先在 B 站登录，再回来重试。";
    default:
      return "未取到 B 站登录凭证（bili_jct），请刷新页面后重试。";
  }
}

/**
 * 读取 B 站 CSRF 令牌（bili_jct）。
 *
 * 只能用 chrome.cookies：该 cookie 是 HttpOnly 的，document.cookie 读不到。
 * cookies 是 optional 权限，未授予时返回 no-permission。
 *
 * 读取 URL 必须是 api.bilibili.com：chrome.cookies 只允许读「已授予主机
 * 权限的 URL」的 cookie，我们授予的是 api.bilibili.com（不是 www）；
 * bili_jct 的 domain 是 .bilibili.com，在 api 子域同样可见。
 */
export async function readBilibiliCsrf(): Promise<CsrfReadResult> {
  const granted = await chrome.permissions.contains({ permissions: ["cookies"] });
  if (!granted) {
    return { status: "no-permission" };
  }
  const cookie = await chrome.cookies.get({
    url: "https://api.bilibili.com/",
    name: "bili_jct",
  });
  const value = cookie?.value?.trim() ?? "";
  if (value === "") {
    return { status: "no-cookie" };
  }
  return { status: "ok", csrf: value };
}
