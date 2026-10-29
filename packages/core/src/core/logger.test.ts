import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureLogging,
  createLogger,
  formatLogLine,
  homePathPrefixes,
  KEEP_FILES,
  logger,
  logFileName,
  pruneOldLogs,
  readTaskLog,
  redactHomePaths,
  redactSecrets,
  rollLogFileName,
  runWithTask,
  tailLog,
  type LogEntry,
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

describe("homePathPrefixes / redactHomePaths", () => {
  test("前缀去重、更长者在前、跳过空值与 /", () => {
    const homes = homePathPrefixes({ HOME: "/Users/a/deep", USERPROFILE: "/Users/a/deep", HOMEDRIVE: "C:" });
    expect(homes.filter((h) => h.prefix === "/Users/a/deep")).toHaveLength(1);
    expect(homes.some((h) => h.prefix === "/")).toBe(false);
    expect(homes.some((h) => h.prefix === "")).toBe(false);
    for (let i = 1; i < homes.length; i++) {
      expect(homes[i - 1]!.prefix.length).toBeGreaterThanOrEqual(homes[i]!.prefix.length);
    }
  });

  test("HOME=/ 时不把根当作前缀", () => {
    expect(homePathPrefixes({ HOME: "/" }).some((h) => h.prefix === "/")).toBe(false);
  });

  test("替换所有出现；无关文本原样保留；mac 用 ~", () => {
    const mac = homePathPrefixes({ HOME: "/Users/link" });
    expect(redactHomePaths("/Users/link/a/b.mp4", mac)).toBe("~/a/b.mp4");
    // 路径嵌在 JSON / URL 里也命中
    expect(redactHomePaths('path="/Users/link/a.mp4" url=file:///Users/link/a.mp4', mac)).toBe('path="~/a.mp4" url=file://~/a.mp4');
    // 无关文本不动
    expect(redactHomePaths("nothing here to see", mac)).toBe("nothing here to see");
    // 空列表不动（Windows 兜底规则除外）
    expect(redactHomePaths("/Users/link/a.mp4", [])).toBe("/Users/link/a.mp4");
  });

  test("Windows 的 C:\\Users\\<user> 替换成 %USERPROFILE%，真实用户名不再出现", () => {
    const win = homePathPrefixes({ USERPROFILE: "C:\\Users\\alice" });
    const line = redactHomePaths("input=C:\\Users\\alice\\Documents\\a.mp4 output=C:/Users/alice/out", win);
    expect(line).toContain("%USERPROFILE%\\Documents\\a.mp4");
    expect(line).not.toContain("alice");
    // USERPROFILE 缺失时也覆盖盘符用户名形态
    expect(redactHomePaths("C:\\Users\\bob\\x.mp4", [])).toBe("%USERPROFILE%\\x.mp4");
  });
});

describe("日志里的 home 替换", () => {
  const FIXTURE_HOME = "/tmp/r46-home-fixture";

  function withHome(home: string, fn: () => void): void {
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
    }
  }

  test("消息与数组字段里的 home 变成 ~；原始 home 不出现；secret 仍是 [redacted]", () => {
    // logger 在改 env 之前创建：证明 homes 是写入时惰性读取
    const { l, lines } = makeSinkLogger();
    withHome(FIXTURE_HOME, () => {
      const input = `${FIXTURE_HOME}/Videos/a b.mp4`;
      const output = `${FIXTURE_HOME}/out/a.mp4`;
      l.info("ffmpeg", `打开 ${input}`, {
        cmd: ["ffmpeg", "-i", input, "-c", "copy", output],
        auth: "Bearer sk-live-987654321",
      });
    });
    const line = lines.at(-1)!;
    expect(line).toContain("打开 ~/Videos/a b.mp4");
    expect(line).toContain('"~/Videos/a b.mp4"');
    expect(line).toContain('"~/out/a.mp4"');
    expect(line).not.toContain(FIXTURE_HOME);
    expect(line).toContain('auth="Bearer [redacted]"');
    expect(line).not.toContain("sk-live-987654321");
  });

  test("secret 先替换再替换 home：密钥不会因 home 截断而漏出", () => {
    const { l, lines } = makeSinkLogger();
    const secret = `{{SECRET_${Date.now()}}}`;
    l.addSecret(secret);
    withHome(FIXTURE_HOME, () => {
      l.info("app", `key=${secret} dir=${FIXTURE_HOME}/keys`);
    });
    const line = lines.at(-1)!;
    expect(line).not.toContain(secret);
    expect(line).toContain("[redacted]");
    expect(line).toContain("dir=~/keys");
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

describe("滚动与保留", () => {
  test("maxBytes 超限时滚动出 vnote-YYYY-MM-DD.1.log，每个文件不超阈值", () => {
    const dir = mkdtempSync(join(tmpdir(), "vnote-roll-"));
    try {
      const l = createLogger({ dir, now: () => T0, maxBytes: 200 });
      for (let i = 0; i < 10; i++) l.info("app", `消息${i}`);
      const base = logFileName(T0);
      const files = readdirSync(dir).filter((n) => n.startsWith("vnote-"));
      expect(files).toContain(rollLogFileName(T0, 1));
      expect(files).toContain(base);
      for (const name of files) expect(statSync(join(dir, name)).size).toBeLessThanOrEqual(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("滚动超过 KEEP_FILES 个后只保留最新 7 个", () => {
    const dir = mkdtempSync(join(tmpdir(), "vnote-keep-"));
    try {
      // 同一天反复滚动制造远超 7 个文件，写入时即自动清理
      const l = createLogger({ dir, now: () => T0, maxBytes: 200 });
      for (let i = 0; i < 60; i++) l.info("app", `消息${i}`);
      const remaining = readdirSync(dir).filter((n) => n.startsWith("vnote-"));
      expect(remaining).toHaveLength(KEEP_FILES);
      // 活跃文件是该天最新，必须保留
      expect(remaining).toContain(logFileName(T0));
      // 保留的是按日期+roll 号最新的 7 个：该天最小编号归档已被删
      const archived = remaining
        .filter((n) => n !== logFileName(T0))
        .map((n) => Number(/\.(\d+)\.log$/.exec(n)![1]));
      expect(archived.length).toBe(KEEP_FILES - 1);
      expect(Math.min(...archived)).toBeGreaterThan(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("跨滚动文件的读取顺序", () => {
  test("tailLog 与 readTaskLog 按日期+roll 升序，.10 排在 .9 之后", () => {
    const dir = mkdtempSync(join(tmpdir(), "vnote-order-"));
    try {
      const day = "2026-10-24";
      // 手工构造含两位 roll 号的文件集
      const names: Array<[string, string]> = [
        [`vnote-${day}.1.log`, "a-1\n"],
        [`vnote-${day}.9.log`, "a-9\n"],
        [`vnote-${day}.10.log`, "a-10\n"],
        [`vnote-${day}.log`, "a-active\n"],
        [`vnote-2026-10-23.log`, "old-day\n"],
      ];
      for (const [name, content] of names) writeFileSync(join(dir, name), content);
      const tail = tailLog(dir);
      expect(tail).toEqual(["old-day", "a-1", "a-9", "a-10", "a-active"]);
      // 给每条行补上 task= 字段再验一次 readTaskLog
      for (const [name] of names) {
        writeFileSync(join(dir, name), `${readFileSync(join(dir, name), "utf8").trimEnd()} task=t1\n`);
      }
      const task = readTaskLog(dir, "t1");
      expect(task).toEqual([
        "old-day task=t1",
        "a-1 task=t1",
        "a-9 task=t1",
        "a-10 task=t1",
        "a-active task=t1",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tap 回调", () => {
  test("收到脱敏后的 entry，taskId 来自 forTask 与 runWithTask", async () => {
    const entries: LogEntry[] = [];
    const l = createLogger({ now: () => T0, tap: (e) => entries.push(e) });
    l.addSecret("{{SECRET_k7x2m4pq}}");
    l.forTask("task-a").info("app", "消息含{{SECRET_k7x2m4pq}}", { url: "https://x.com/?api_key={{SECRET_k7x2m4pq}}" });
    await runWithTask("task-b", () => {
      l.warn("app", "期间警告");
      return Promise.resolve();
    });
    l.debug("app", "低于级别不应出现");
    expect(entries).toHaveLength(2);
    const first = entries[0];
    const second = entries[1];
    if (first === undefined || second === undefined) throw new Error("tap 应收到两条日志");
    expect(first.taskId).toBe("task-a");
    expect(first.message).toBe("消息含[redacted]");
    expect(first.fields.url).toBe("https://x.com/?api_key=[redacted]");
    expect(first.level).toBe("info");
    expect(first.date.getTime()).toBe(T0.getTime());
    expect(second.taskId).toBe("task-b");
    expect(second.level).toBe("warn");
  });
});

describe("formatLogLine", () => {
  test("error 行输出 [HH:MM:SS] 错误 message（本地时间）", () => {
    const d = new Date(2026, 9, 24, 14, 3, 7);
    expect(formatLogLine({ date: d, level: "error", module: "app", message: "出错了", fields: {}, taskId: null })).toBe("[14:03:07] 错误 出错了");
    expect(formatLogLine({ date: d, level: "warn", module: "app", message: "有警告", fields: {}, taskId: null })).toBe("[14:03:07] 警告 有警告");
    expect(formatLogLine({ date: d, level: "info", module: "app", message: "普通信息", fields: {}, taskId: null })).toBe("[14:03:07] 普通信息");
  });
});
