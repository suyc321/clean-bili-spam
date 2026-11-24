/**
 * 页面适配器契约：采集层与系统其余部分的边界接口。
 *
 * 依赖规则（工程核心约束）：
 * - 适配器可以访问 DOM 与 URL，但不得访问存储、判定或网络；
 * - 其余模块只依赖本文件声明的类型，不感知 B 站具体页面结构。
 */
import type {
  AccountKey,
  ObservationSource,
  PageKind,
  VideoObservationInput,
} from "../domain/types";

/** 单个页面种类的适配器。 */
export interface PageAdapter {
  /** 适配器标识（如 bilibili-home-v1），随观察记录持久化。 */
  readonly id: string;
  /** 适配器版本号，结构变更时递增，便于区分新旧数据。 */
  readonly version: number;
  /** 适配的页面种类。 */
  readonly pageKind: PageKind;

  /** 判断该适配器是否处理当前页面。 */
  matches(url: URL, document: Document): boolean;
  /**
   * 扫描页面，提取卡片与诊断信息。
   * @param candidateCards 候选卡片元素（增量扫描时由调用方提供新增卡片）；
   * 省略时扫描页面上全部卡片
   */
  scan(
    document: Document,
    url: URL,
    nowMs: number,
    candidateCards?: Iterable<Element>,
  ): AdapterScanResult;
}

/** 一次扫描的完整结果。 */
export interface AdapterScanResult {
  adapterId: string;
  adapterVersion: number;
  pageKind: PageKind;
  /**
   * 适配器健康度（仅代表本轮扫描范围）：
   * - healthy：卡片正常解析；
   * - degraded：本轮范围内卡片缺失或过半解析不出稳定身份。这是诊断信号，
   *   已解析出身份的卡片仍可提交；页面级健康度由 content/page-stats 按
   *   整页已见卡片计算；
   * - unsupported：没有匹配的适配器。
   */
  health: "healthy" | "degraded" | "unsupported";
  cards: ExtractedCard[];
  /** 各选择器的匹配诊断，用于排查页面改版。 */
  diagnostics: AdapterDiagnostic[];
}

/** 从单个视频卡片提取出的结构化数据。 */
export interface ExtractedCard {
  /** 卡片稳定键：适配器 ID + BVID + 账号键（身份未解析时用序号占位）。 */
  cardKey: string;
  /** 账号主键；解析失败时为 undefined，该卡片不写入本地数据库。 */
  accountKey?: AccountKey;
  /** UP 主 UID（可选，失败即缺失）。 */
  uid?: string;
  /** UID 的解析来源：卡片内链接 / 搜索模块 / 空间页地址 / 缺失。 */
  uidSource: "card" | "search-module" | "space-url" | "missing";
  displayName?: string;
  profileUrl?: string;
  /** UP 主简介（目前仅空间页适配器能拿到）。 */
  profileBio?: string;
  /** 卡片对应的视频观察数据。 */
  video: VideoObservationInput;
  /** 采集时缺失的字段清单。 */
  missingFields: string[];
  source: ObservationSource;
  /** 标签渲染挂载点：卡片根元素与视频链接锚点。 */
  mount: {
    cardElement: HTMLElement;
    anchorElement: HTMLAnchorElement;
  };
}

/** 单个选择器的诊断结果。 */
export interface AdapterDiagnostic {
  /** 选择器语义名（如 video-card、stable-account-identity）。 */
  selectorKey: string;
  status: "matched" | "fallback" | "missing" | "parse-failed";
  /** 匹配数量（可选）。 */
  count?: number;
}
