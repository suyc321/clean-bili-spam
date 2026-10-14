// 解析器测试：BVID/UID 严格解析（含伪装域名拒绝）与发布时间文本解析。
import { describe, expect, it } from "vitest";
import {
  parseBilibiliProfileUrl,
  parseBilibiliVideoUrl,
  parsePublishedAt,
  parseSpaceUidFromPage,
} from "../src/adapters/bilibili/parsers";

describe("B站 URL 解析", () => {
  it("从绝对和协议相对视频链接提取 BVID", () => {
    expect(
      parseBilibiliVideoUrl(
        "https://www.bilibili.com/video/BV1Ab411c7xY/?spm_id_from=333",
        "https://www.bilibili.com/",
      )?.bvid,
    ).toBe("BV1Ab411c7xY");
    expect(
      parseBilibiliVideoUrl(
        "//www.bilibili.com/video/BV9xy4y1Z7Q2",
        "https://search.bilibili.com/all",
      )?.bvid,
    ).toBe("BV9xy4y1Z7Q2");
  });

  it("拒绝伪装域名和非视频路径", () => {
    expect(
      parseBilibiliVideoUrl(
        "https://www.bilibili.com.evil.example/video/BV1Ab411c7xY",
        "https://www.bilibili.com/",
      ),
    ).toBeUndefined();
    expect(
      parseBilibiliVideoUrl(
        "https://member.bilibili.com/platform/upload/video/frame",
        "https://www.bilibili.com/",
      ),
    ).toBeUndefined();
  });

  it("把 UID 始终作为字符串解析", () => {
    const parsed = parseBilibiliProfileUrl(
      "https://space.bilibili.com/900719925474099312345/video",
      "https://www.bilibili.com/",
    );
    expect(parsed?.uid).toBe("900719925474099312345");
    expect(
      parseSpaceUidFromPage(
        new URL("https://space.bilibili.com/87654321/video"),
      ),
    ).toBe("87654321");
  });
});

describe("发布时间解析", () => {
  const now = new Date(2026, 6, 31, 12, 0, 0).getTime();

  it("解析分钟、小时和天的相对时间", () => {
    expect(parsePublishedAt("30分钟前", now)).toBe(now - 30 * 60_000);
    expect(parsePublishedAt("2小时前", now)).toBe(
      now - 2 * 60 * 60_000,
    );
    expect(parsePublishedAt("3天前", now)).toBe(
      now - 3 * 24 * 60 * 60_000,
    );
  });

  it("不为无法确认的时间文本伪造时间戳", () => {
    expect(parsePublishedAt("昨天 12:30", now)).toBeUndefined();
    expect(parsePublishedAt("神秘时间", now)).toBeUndefined();
  });
});
