/**
 * 收尾产物完整（r58 验收 5）：远端证据按清单逐项拉取，漏拉的补齐，仍缺就报错。
 *
 * `down --target win-gamepc` 以前只按文件名白名单拉 `video.json` / `topic.md` /
 * `trajectory.json` / `status.json`，其它产物（例如 `labels.json`、`analysis.json`、
 * 子目录里的日志）会静默留在远端。这里把「应拉取清单」变成可测试的纯函数：
 * 远端递归清单 → 排除缓存 → 逐个比对本地大小。
 */
import { describe, expect, test } from "bun:test";
import { evidenceGaps, evidenceInventory, expectedEvidence, isCacheFile, parseRemoteListing, relativeEvidencePath } from "./evidence";

const RUN = "D:\\code\\video-notes\\verify\\r58-win";

describe("parseRemoteListing", () => {
  test("`<bytes>\\t<path>`，路径里的空格原样保留", () => {
    const output = [
      "1024\tD:\\code\\video-notes\\verify\\r58-win\\app.log",
      "42\tD:\\code\\video-notes\\verify\\r58-win\\home\\视频 1\\video.json",
      "",
    ].join("\r\n");
    expect(parseRemoteListing(output)).toEqual([
      { path: "D:\\code\\video-notes\\verify\\r58-win\\app.log", bytes: 1024 },
      { path: "D:\\code\\video-notes\\verify\\r58-win\\home\\视频 1\\video.json", bytes: 42 },
    ]);
  });

  test("坏行（没有分隔符、字节数不是数字）被跳过而不是变出一条 0 字节记录", () => {
    expect(parseRemoteListing(["junk", "notanumber\tC:\\x", "7\tC:\\y"].join("\n"))).toEqual([{ path: "C:\\y", bytes: 7 }]);
  });

  test("零字节文件也保留：它同样是证据（例如空日志）", () => {
    expect(parseRemoteListing("0\tC:\\empty.log")).toEqual([{ path: "C:\\empty.log", bytes: 0 }]);
  });
});

describe("isCacheFile", () => {
  test("渲染进程缓存与 Lab 缓存不算证据", () => {
    expect(isCacheFile(`${RUN}\\home\\.cache\\index`, RUN)).toBe(true);
    expect(isCacheFile(`${RUN}\\home\\.cache\\lab\\entry\\audio.wav`, RUN)).toBe(true);
  });

  test("日志与产物是证据", () => {
    expect(isCacheFile(`${RUN}\\home\\logs\\vnote-2026-10-31.log`, RUN)).toBe(false);
    expect(isCacheFile(`${RUN}\\app.log`, RUN)).toBe(false);
    expect(isCacheFile(`${RUN}\\launch.ps1`, RUN)).toBe(false);
  });

  test("run 目录之外的路径按相对路径处理，不误判", () => {
    expect(isCacheFile("C:\\Users\\xieal\\Documents\\.cache\\x", RUN)).toBe(true);
    expect(isCacheFile("C:\\Users\\xieal\\Documents\\video.json", RUN)).toBe(false);
  });
});

describe("expectedEvidence", () => {
  test("排除缓存后保留其余全部文件（清单即契约）", () => {
    const listing = [
      { path: `${RUN}\\app.log`, bytes: 10 },
      { path: `${RUN}\\home\\.cache\\junk`, bytes: 2 },
      { path: `${RUN}\\home\\logs\\vnote.log`, bytes: 3 },
      { path: `${RUN}\\home\\视频1\\video.json`, bytes: 4 },
      { path: `${RUN}\\home\\视频1\\labels.json`, bytes: 5 },
      { path: `${RUN}\\home\\视频1\\analysis.json`, bytes: 6 },
    ];
    expect(expectedEvidence(listing, RUN).map((entry) => entry.path)).toEqual([
      `${RUN}\\app.log`,
      `${RUN}\\home\\logs\\vnote.log`,
      `${RUN}\\home\\视频1\\video.json`,
      `${RUN}\\home\\视频1\\labels.json`,
      `${RUN}\\home\\视频1\\analysis.json`,
    ]);
  });
});

describe("evidenceGaps", () => {
  const expected = [
    { path: `${RUN}\\app.log`, bytes: 10 },
    { path: `${RUN}\\home\\logs\\vnote.log`, bytes: 3 },
    { path: `${RUN}\\home\\视频1\\video.json`, bytes: 4 },
  ];

  test("全部拉齐且大小一致：没有缺口", () => {
    const sizes = new Map(expected.map((entry) => [entry.path, entry.bytes]));
    expect(evidenceGaps(expected, (path) => sizes.get(path) ?? null)).toEqual([]);
  });

  test("没拉到：missing", () => {
    expect(evidenceGaps(expected, () => null)).toEqual([
      { path: `${RUN}\\app.log`, reason: "missing", expectedBytes: 10, localBytes: null },
      { path: `${RUN}\\home\\logs\\vnote.log`, reason: "missing", expectedBytes: 3, localBytes: null },
      { path: `${RUN}\\home\\视频1\\video.json`, reason: "missing", expectedBytes: 4, localBytes: null },
    ]);
  });

  test("拉到了但被截断：size（只比存在性会把半个文件当完整）", () => {
    const gaps = evidenceGaps(expected, (path) => (path.endsWith("video.json") ? 2 : expected.find((entry) => entry.path === path)?.bytes ?? null));
    expect(gaps).toEqual([{ path: `${RUN}\\home\\视频1\\video.json`, reason: "size", expectedBytes: 4, localBytes: 2 }]);
  });
});

describe("evidenceInventory", () => {
  const MB = 1024 * 1024;

  test("大体积媒体不拉取，但要在 skipped 清单里列出来（不是静默漏掉）", () => {
    const inventory = evidenceInventory(
      [
        { path: `${RUN}\\app.log`, bytes: 10 },
        { path: `${RUN}\\home\\视频1\\topic.mp4`, bytes: 40 * MB },
        { path: `${RUN}\\home\\视频1\\video.json`, bytes: 4 },
      ],
      RUN,
    );
    expect(inventory.expected.map((entry) => entry.path)).toEqual([`${RUN}\\app.log`, `${RUN}\\home\\视频1\\video.json`]);
    expect(inventory.skipped).toEqual([{ path: `${RUN}\\home\\视频1\\topic.mp4`, bytes: 40 * MB }]);
  });

  test("小媒体仍然算证据；非媒体大文件也照拉（日志、JSON）", () => {
    const inventory = evidenceInventory(
      [
        { path: `${RUN}\\home\\a\\clip.MP4`, bytes: 2 * MB },
        { path: `${RUN}\\home\\logs\\vnote.log`, bytes: 20 * MB },
      ],
      RUN,
    );
    expect(inventory.expected).toHaveLength(2);
    expect(inventory.skipped).toEqual([]);
  });

  test("刚好等于上限的媒体保留（只有超过才跳过）", () => {
    const inventory = evidenceInventory([{ path: `${RUN}\\home\\a\\audio.wav`, bytes: 8 * MB }], RUN, 8 * MB);
    expect(inventory.expected).toHaveLength(1);
  });

  test("缓存既不拉也不进 skipped", () => {
    const inventory = evidenceInventory([{ path: `${RUN}\\home\\.cache\\big.mp4`, bytes: 99 * MB }], RUN);
    expect(inventory).toEqual({ expected: [], skipped: [] });
  });
});

describe("relativeEvidencePath", () => {
  test("反斜杠与正斜杠都拆成路径段", () => {
    expect(relativeEvidencePath(`${RUN}\\home\\logs\\a.log`, RUN)).toEqual(["home", "logs", "a.log"]);
    expect(relativeEvidencePath("D:/code/video-notes/verify/r58-win/home/logs/a.log", "D:\\code\\video-notes\\verify\\r58-win")).toEqual([
      "home",
      "logs",
      "a.log",
    ]);
  });

  test("大小写不敏感地剥掉 run 目录前缀（Windows 路径）", () => {
    expect(relativeEvidencePath("d:\\code\\VIDEO-notes\\verify\\r58-win\\app.log", RUN)).toEqual(["app.log"]);
  });

  test("run 目录之外的路径保留完整段（不会被误截断）", () => {
    expect(relativeEvidencePath("C:\\Users\\xieal\\Documents\\video.json", RUN)).toEqual(["C:", "Users", "xieal", "Documents", "video.json"]);
  });
});
