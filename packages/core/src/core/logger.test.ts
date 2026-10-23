import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureLogging,
  createLogger,
  logger,
  logFileName,
  pruneOldLogs,
  readTaskLog,
  redactSecrets,
  runWithTask,
} from "./logger";

const T0 = new Date("2026-10-24T05:31:02.123Z");

function makeSinkLogger() {
  const lines: string[] = [];
  const l = createLogger({ now: () => T0, sink: (s) => lines.push(s) });
  return { l, lines };
}

describe("行格式", () => {
  test("单条记录的精确行形状（无 task）", () => {
    const { l, lines } = makeSinkLogger();
    l.info("import", "开始导入", { video: "ab12cd34", path: "/tmp/a b.mp4", n: 3, skip: undefined });
    expect(lines).toEqual([
      '2026-10-24T05:31:02.123Z INFO  import 开始导入 video="ab12cd34" path="/tmp/a b.mp4" n=3',
    ]);
  });

  test("单条记录的精确行形状（带 task，与示例逐字对齐）", () => {
    const { l, lines } = makeSinkLogger();
    l.forTask("8f2a").info("import", "开始导入", { video: "ab12cd34", path: "/tmp/a b.mp4" });
    expect(lines).toEqual([
      '2026-10-24T05:31:02.123Z INFO  import task=8f2a 开始导入 video="ab12cd34" path="/tmp/a b.mp4"',
    ]);
  });

  test("level 过滤：低于 logger level 的记录在格式化前丢弃", () => {
    const { l, lines } = makeSinkLogger();
    l.debug("app", "debug 不应出现");
    l.info("app", "info 出现");
    l.warn("app", "warn 出现");
    l.error("app", "error 出现");
    expect(lines).toEqual([
      "2026-10-24T05:31:02.123Z INFO  app info 出现",
      "2026-10-24T05:31:02.123Z WARN  app warn 出现",
      "2026-10-24T05:31:02.123Z ERROR app error 出现",
    ]);
  });
});

describe("runWithTask 任务作用域", () => {
  test("期间记录带 task，结束后恢复（正常路径）", async () => {
    const { l, lines } = makeSinkLogger();
    l.info("app", "之前");
    await runWithTask("task-a", () => {
      l.info("app", "期间");
      return Promise.resolve(1);
    });
    l.info("app", "之后");
    expect(lines).toEqual([
      "2026-10-24T05:31:02.123Z INFO  app 之前",
      "2026-10-24T05:31:02.123Z INFO  app task=task-a 期间",
      "2026-10-24T05:31:02.123Z INFO  app 之后",
    ]);
  });

  test("抛错后仍然恢复 task", async () => {
    const { l, lines } = makeSinkLogger();
    await expect(
      runWithTask("task-b", () => {
        l.info("app", "期间");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    l.info("app", "之后");
    expect(lines).toEqual([
      "2026-10-24T05:31:02.123Z INFO  app task=task-b 期间",
      "2026-10-24T05:31:02.123Z INFO  app 之后",
    ]);
  });
});

describe("文件写入与 readTaskLog", () => {
  test("追加写日志文件并按 task 过滤、maxLines 从末尾截断", () => {
    const dir = mkdtempSync(join(tmpdir(), "vnote-"));
    try {
      const l = createLogger({ dir, now: () => T0 });
      l.addSecret("secret-token-1234");
      const t = l.forTask("8f2a");
      t.info("app", "第一条", { n: 1 });
      t.info("app", "第二条", { n: 2 });
      t.warn("app", "第三条", { n: 3 });
      t.info("app", "第四条", { n: 4 });
      // 别的 task 与无 task 的行不应被过滤出来
      l.forTask("9c1d").info("app", "别的任务");
      l.info("app", "无任务");
      expect(l.file()).toBe(join(dir, logFileName(T0)));
      const all = readTaskLog(dir, "8f2a");
      expect(all).toHaveLength(4);
      expect(all[0]).toContain("第一条");
      for (const line of all) expect(line).toContain("task=8f2a");
      const capped = readTaskLog(dir, "8f2a", 2);
      expect(capped).toHaveLength(2);
      expect(capped[0]).toContain("第三条");
      expect(capped[1]).toContain("第四条");
      // 跨文件：另一个日期文件的旧行排在前面
      const oldDate = new Date("2026-10-22T05:31:02.123Z");
      writeFileSync(join(dir, logFileName(oldDate)), "2026-10-22T05:31:02.123Z INFO  app task=8f2a 旧的\n");
      const across = readTaskLog(dir, "8f2a");
      expect(across[0]).toContain("旧的");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pruneOldLogs", () => {
  test("删除超过 7 天的文件，并只保留最新 7 个", () => {
    const dir = mkdtempSync(join(tmpdir(), "vnote-prune-"));
    try {
      // 固定基准日，避免真实时钟落在 7 天边界导致 flaky
      const now = new Date("2026-10-24T12:00:00Z");
      const day = (offset: number) => logFileName(new Date(now.getTime() - offset * 86400000));
      // 12 个日志文件，距今 0~11 天：>7 天的 4 个被天数规则删，第 7 天被数量规则删
      for (let i = 0; i < 12; i++) writeFileSync(join(dir, day(i)), "x\n");
      writeFileSync(join(dir, "not-a-log.txt"), "x\n");
      const removed = pruneOldLogs(dir, 7, now);
      expect(removed.sort()).toEqual([day(11), day(10), day(9), day(8), day(7)].sort());
      // 不匹配 LOG_FILE_RE 的文件不被动
      expect(readFileSync(join(dir, "not-a-log.txt"), "utf8")).toBe("x\n");
      const logs = readdirSync(dir).filter((n) => n.startsWith("vnote-"));
      expect(logs).toHaveLength(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("redactSecrets", () => {
  test("消息、URL query、token=、api_key=、bearer 头中的 secret 都被替换", () => {
    const token = "secret-token-1234";
    const secrets = [token];
    // 消息里的 URL query
    expect(redactSecrets(`url=https://x.com/upload?key=${token}`, secrets)).toBe("url=https://x.com/upload?key=[redacted]");
    // token= 风格赋值
    expect(redactSecrets("https://x.com/?token=sk-test-suzpnwox", secrets)).toBe("https://x.com/?token=[redacted]");
    // api_key= 风格赋值
    expect(redactSecrets("api_key=sk-test-jifcihdl", secrets)).toBe("api_key=[redacted]");
    // authorization: 头（含 bearer）
    expect(redactSecrets("Authorization: Bearer sk-live-987654321", secrets)).toBe("Authorization: [redacted]");
    // 普通 bearer（非 authorization 前缀）
    expect(redactSecrets("Bearer sk-live-987654321", secrets)).toBe("Bearer [redacted]");
    // 短于 4 字符的 secret 不处理
    expect(redactSecrets("abab", ["ab"])).toBe("abab");
    // 空 secret 列表不改动文本
    expect(redactSecrets("nothing here", [])).toBe("nothing here");
  });

  test("addSecret 后，sink 与文件输出都不含 key（含 argv URL）", () => {
    const dir = mkdtempSync(join(tmpdir(), "vnote-sec-"));
    try {
      const lines: string[] = [];
      const l = createLogger({ dir, now: () => T0, sink: (s) => lines.push(s) });
      l.addSecret("super-secret-key-42");
      l.info("ffmpeg", "执行", { cmd: ["curl", "-X", "POST", "https://api.x.com/v1?api_key=super-secret-key-42"] });
      expect(lines.join("\n")).not.toContain("super-secret-key-42");
      const file = readFileSync(l.file()!, "utf8");
      expect(file).not.toContain("super-secret-key-42");
      expect(file).toContain("api_key=[redacted]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("进程级 logger", () => {
  test("未 configure 时丢弃所有日志；configure 后生效", () => {
    expect(() => logger().info("app", "hello")).not.toThrow();
    const l = configureLogging({ sink: () => {} });
    expect(l.level).toBe("info");
    expect(l.file()).toBeNull();
  });
});
