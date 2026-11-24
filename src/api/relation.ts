/**
 * B 站用户关系操作：拉黑 / 取消拉黑。
 *
 * 背景：B 站没有开放的「一键拉黑」接口，只有网页端自己使用的关系接口。
 * 本模块把它封装成可注入 fetch 的纯调用，供 Service Worker 在用户明确
 * 确认后调用。要点：
 * - 需要 `api.bilibili.com` 的运行时授权（安装时零授权，首次点击时申请）；
 * - 需要当前 B 站页面的 CSRF 令牌（bili_jct，由内容脚本从 document.cookie
 *   读取后随消息传入——Service Worker 读不到页面 cookie）；
 * - act=5 拉黑、act=6 取消拉黑；接口以 code===0 表示成功。
 *
 * 安全姿态：这是不可轻易撤销的平台动作，调用方（内容脚本）必须做二次确认，
 * 并且只应在用户明确意图下触发。
 */
import type { AccountKey } from "../domain/types";

/** B 站关系修改接口。 */
const RELATION_ENDPOINT = "https://api.bilibili.com/x/relation/modify";

/** 关系操作类型：5=拉黑，6=取消拉黑。 */
export type RelationAction = "block" | "unblock";

const ACTION_CODE: Record<RelationAction, number> = {
  block: 5,
  unblock: 6,
};

/** 关系操作所需的上下文（CSRF 令牌来自页面 cookie）。 */
export interface RelationRequest {
  /** 目标账号 UID。 */
  uid: string;
  /** 当前 B 站页面的 bili_jct（CSRF）令牌。 */
  csrf: string;
}

/** 关系操作结果。 */
export interface RelationResult {
  accountKey: AccountKey;
  /** 操作后的状态：true=已拉黑，false=已取消。 */
  blocked: boolean;
}

/**
 * 调用 B 站关系接口。
 *
 * @param action block / unblock
 * @param request 目标 UID 与 CSRF 令牌
 * @param fetchImpl 可注入的 fetch（测试用）
 * @throws Error 网络失败、鉴权失败或接口返回非 0 时抛出，消息为面向用户的中文
 */
export async function modifyRelation(
  action: RelationAction,
  request: RelationRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const csrf = request.csrf.trim();
  if (csrf === "") {
    throw new Error("未取到 CSRF 令牌，请刷新 B 站页面后重试。");
  }
  const body = new URLSearchParams({
    fid: request.uid,
    act: String(ACTION_CODE[action]),
    re_src: "11",
    csrf,
  });
  const response = await fetchImpl(RELATION_ENDPOINT, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      // 不手写 Referer：它是 fetch 的 forbidden header，浏览器会静默丢弃。
      // 请求从 B 站页面上下文发出，浏览器会自动带上正确的来源。
    },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`B 站接口返回 HTTP ${response.status}。`);
  }
  const payload = (await response.json()) as { code?: number; message?: string };
  if (payload.code !== 0) {
    throw new Error(
      `B 站接口拒绝了本次操作（code=${payload.code ?? "未知"}${payload.message ? `：${payload.message}` : ""}）。`.slice(
        0,
        200,
      ),
    );
  }
}

/** 关系属性中「已拉黑」位（实测：拉黑后 attribute=128，取消后 0）。 */
export function isBlockedAttribute(attribute: number): boolean {
  return (attribute & 128) !== 0;
}

/**
 * 查询与某用户的关系属性（是否被拉黑等）。
 *
 * 从页面上下文调用（内容脚本的 fetch 带页面 cookie 与来源，B 站信任）。
 * 未登录（code -101）、风控或其他错误时返回 null，由调用方保持现状。
 */
export async function fetchRelationAttribute(
  uid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  try {
    const response = await fetchImpl(
      `https://api.bilibili.com/x/relation?fid=${encodeURIComponent(uid)}`,
      { credentials: "include" },
    );
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as {
      code?: number;
      data?: { attribute?: number };
    };
    if (payload.code !== 0 || typeof payload.data?.attribute !== "number") {
      return null;
    }
    return payload.data.attribute;
  } catch {
    return null;
  }
}
