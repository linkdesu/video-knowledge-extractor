import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureLogging, type LogEntry } from "@video-notes/core";
import { createSecretStore, plainFileCodec, type SecretCodec } from "./secrets";

/** 假 codec：base64「加密」，可注入解密失败，覆盖往返、坏密文、权限、clear，不依赖 Electron。 */
function fakeCodec(decryptError: string | null = null): SecretCodec {
  return {
    available: () => true,
    encrypt: (plain: string) => Buffer.from(`enc:${plain}`, "utf8"),
    decrypt: (cipher: Buffer) => {
      if (decryptError !== null) throw new Error(decryptError);
      const text = cipher.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("bad cipher");
      return text.slice(4);
    },
  };
}

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "vnote-secrets-")), "secrets.bin");
}

/** 密钥库测试不读设置文件，但仍按 ADR-0016 §12 把进程环境指向临时目录并在结束时恢复。 */
let envDir: string;
let prevHome: string | undefined;
let prevUserData: string | undefined;

beforeEach(() => {
  prevHome = process.env.VNOTE_HOME;
  prevUserData = process.env.VNOTE_USER_DATA;
  envDir = mkdtempSync(join(tmpdir(), "vnote-secrets-env-"));
  process.env.VNOTE_HOME = join(envDir, "home");
  process.env.VNOTE_USER_DATA = join(envDir, "user-data");
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.VNOTE_HOME;
  else process.env.VNOTE_HOME = prevHome;
  if (prevUserData === undefined) delete process.env.VNOTE_USER_DATA;
  else process.env.VNOTE_USER_DATA = prevUserData;
  rmSync(envDir, { recursive: true, force: true });
});

describe("createSecretStore", () => {
  test("加密往返：set 后落盘的是 codec 密文，重载后 get/has 一致", () => {
    const file = tempFile();
    const store = createSecretStore({ file, codec: fakeCodec() });
    store.set("llm", "k1");
    const cipher = readFileSync(file, "utf8");
    expect(cipher.startsWith("enc:")).toBe(true);
    expect(cipher).toContain('"llm":"k1"');
    expect(JSON.parse(fakeCodec().decrypt(Buffer.from(cipher, "utf8")))).toEqual({ version: 2, llm: "k1" });
    const again = createSecretStore({ file, codec: fakeCodec() });
    expect(again.has("llm")).toBe(true);
    expect(again.get("llm")).toBe("k1");
    expect(again.has("asr")).toBe(false);
    expect(again.all()).toEqual(["k1"]);
  });

  test("version 1 旧文件可读（llm/asr），下一次保存写 version 2", () => {
    const file = tempFile();
    writeFileSync(file, Buffer.from(`enc:${JSON.stringify({ version: 1, llm: "old-llm", asr: "old-asr" })}`));
    const store = createSecretStore({ file, codec: fakeCodec() });
    expect(store.error()).toBe(null);
    expect(store.get("llm")).toBe("old-llm");
    expect(store.get("asr")).toBe("old-asr");
    expect(store.has("volcApiKey")).toBe(false);
    store.set("volcAppKey", "volc-app");
    const body = JSON.parse(fakeCodec().decrypt(readFileSync(file)));
    expect(body).toEqual({ version: 2, llm: "old-llm", asr: "old-asr", volcAppKey: "volc-app" });
  });

  test("version 2 往返覆盖全部五个 id", () => {
    const file = tempFile();
    const store = createSecretStore({ file, codec: fakeCodec() });
    store.set("llm", "l");
    store.set("asr", "a");
    store.set("volcApiKey", "vk");
    store.set("volcAppKey", "ak");
    store.set("volcAccessKey", "sk");
    const again = createSecretStore({ file, codec: fakeCodec() });
    expect(again.get("llm")).toBe("l");
    expect(again.get("asr")).toBe("a");
    expect(again.get("volcApiKey")).toBe("vk");
    expect(again.get("volcAppKey")).toBe("ak");
    expect(again.get("volcAccessKey")).toBe("sk");
    expect(again.error()).toBe(null);
    expect(JSON.parse(fakeCodec().decrypt(readFileSync(file)))).toEqual({
      version: 2,
      llm: "l",
      asr: "a",
      volcApiKey: "vk",
      volcAppKey: "ak",
      volcAccessKey: "sk",
    });
  });

  test("未知版本：保留原文件、报可读原因、视作没有已存 key", () => {
    const file = tempFile();
    const raw = Buffer.from(`enc:${JSON.stringify({ version: 3, llm: "x" })}`);
    writeFileSync(file, raw);
    const store = createSecretStore({ file, codec: fakeCodec() });
    expect(store.get("llm")).toBeUndefined();
    expect(store.has("llm")).toBe(false);
    expect(store.error()).toContain("版本不支持");
    expect(readFileSync(file).equals(raw)).toBe(true);
  });

  test("坏字段形状（非字符串/空串）：保留原文件并报错", () => {
    const notString = tempFile();
    const rawNotString = Buffer.from(`enc:${JSON.stringify({ version: 2, llm: 5 })}`);
    writeFileSync(notString, rawNotString);
    const s1 = createSecretStore({ file: notString, codec: fakeCodec() });
    expect(s1.error()).toContain("llm");
    expect(s1.all()).toEqual([]);
    expect(readFileSync(notString).equals(rawNotString)).toBe(true);

    const empty = tempFile();
    const rawEmpty = Buffer.from(`enc:${JSON.stringify({ version: 2, volcAccessKey: "" })}`);
    writeFileSync(empty, rawEmpty);
    const s2 = createSecretStore({ file: empty, codec: fakeCodec() });
    expect(s2.error()).toContain("volcAccessKey");
    expect(s2.all()).toEqual([]);
    expect(readFileSync(empty).equals(rawEmpty)).toBe(true);
  });

  test("文件权限 0o600", () => {
    // Windows 的 chmod 只映射只读位，POSIX 模式位没有意义
    if (process.platform === "win32") return;
    const file = tempFile();
    const store = createSecretStore({ file, codec: fakeCodec() });
    store.set("asr", "k2");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("坏密文：保留原文件、get 为 undefined、error 可读，显式 set 才重写", () => {
    const file = tempFile();
    const store = createSecretStore({ file, codec: fakeCodec() });
    store.set("llm", "old");
    const badCipher = readFileSync(file);
    const broken = createSecretStore({ file, codec: fakeCodec("cannot decrypt") });
    expect(broken.has("llm")).toBe(false);
    expect(broken.get("llm")).toBeUndefined();
    expect(broken.error()).toContain("解密失败");
    expect(readFileSync(file).equals(badCipher)).toBe(true);
    store.set("llm", "new");
    expect(JSON.parse(fakeCodec().decrypt(readFileSync(file)))).toEqual({ version: 2, llm: "new" });
  });

  test("坏 JSON：保留原文件并报错", () => {
    const file = tempFile();
    writeFileSync(file, Buffer.from("enc:{"));
    const store = createSecretStore({ file, codec: fakeCodec() });
    expect(store.get("llm")).toBeUndefined();
    expect(store.error()).toContain("JSON");
    expect(readFileSync(file, "utf8")).toBe("enc:{");
  });

  test("clear 删除条目；set 空串按 clear；codec 不可用时 set 报错", () => {
    const file = tempFile();
    const store = createSecretStore({ file, codec: fakeCodec() });
    store.set("asr", "x");
    expect(store.has("asr")).toBe(true);
    store.clear("asr");
    expect(store.has("asr")).toBe(false);
    store.set("llm", "");
    expect(store.has("llm")).toBe(false);
    const unavailable = { available: () => false, encrypt: (p: string) => Buffer.from(p), decrypt: (c: Buffer) => c.toString() };
    const s2 = createSecretStore({ file, codec: unavailable });
    expect(s2.available()).toBe(false);
    expect(() => s2.set("llm", "y")).toThrow("本机私有密钥文件不可写，无法保存密钥");
  });

  test("all 返回全部五个非空值，给脱敏用", () => {
    const file = tempFile();
    const store = createSecretStore({ file, codec: fakeCodec() });
    store.set("llm", "llm-key");
    store.set("asr", "asr-key");
    store.set("volcApiKey", "volc-api");
    store.set("volcAppKey", "volc-app");
    store.set("volcAccessKey", "volc-access");
    expect(store.all()).toEqual(["llm-key", "asr-key", "volc-api", "volc-app", "volc-access"]);
    store.clear("llm");
    store.clear("volcAppKey");
    expect(store.all()).toEqual(["asr-key", "volc-api", "volc-access"]);
  });
  test("plainFileCodec：0o600 本地 JSON 往返且遇到旧版 safeStorage 二进制密文时静默重置不报错", () => {
    const file = tempFile();
    // 模拟旧版 safeStorage 留下的 v10 二进制密文
    writeFileSync(file, Buffer.from([0x76, 0x31, 0x30, 0x89, 0xfe, 0x00, 0x42]));
    const migrated = createSecretStore({ file, codec: plainFileCodec });
    expect(migrated.error()).toBe(null);
    expect(migrated.available()).toBe(true);
    expect(migrated.has("llm")).toBe(false);
    migrated.set("llm", "sk-plain-123");
    const reloaded = createSecretStore({ file, codec: plainFileCodec });
    expect(reloaded.error()).toBe(null);
    expect(reloaded.get("llm")).toBe("sk-plain-123");
  });
});

describe("旧版 safeStorage 密文迁移（r64）", () => {
  function legacyFile(): string {
    const file = tempFile();
    writeFileSync(file, Buffer.from([0x76, 0x31, 0x30, 0x89, 0xfe, 0x00, 0x42]));
    return file;
  }

  function backups(file: string): string[] {
    return readdirSync(join(file, "..")).filter((name) => name.includes(".legacy-"));
  }

  /** 每次断言都拿一份独立日志，不跨用例串味。 */
  function captureLogs(): LogEntry[] {
    const entries: LogEntry[] = [];
    configureLogging({ console: false, tap: (e) => entries.push(e) });
    return entries;
  }

  afterEach(() => {
    configureLogging({ console: false });
  });

  test("迁移成功：只记 INFO，不再先打「已失效」WARN（r45c GAP-1）", async () => {
    const file = legacyFile();
    const store = createSecretStore({ file, codec: plainFileCodec });
    const entries = captureLogs();
    const result = await store.migrateLegacy(async () => JSON.stringify({ version: 2, llm: "old-dpapi-key" }));
    expect(result).toBe("migrated");
    expect(store.get("llm")).toBe("old-dpapi-key");
    expect(store.error()).toBe(null);
    expect(backups(file)).toHaveLength(1);
    expect(entries.filter((e) => e.level === "warn")).toEqual([]);
    expect(entries.filter((e) => e.level === "info").map((e) => e.message)).toEqual([
      "旧版系统加密密钥已迁移到本地密钥文件",
    ]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 2, llm: "old-dpapi-key" });
  });

  test("迁移失败：只记一条 WARN（含备份路径），保持空表、不抛错", async () => {
    const file = legacyFile();
    const store = createSecretStore({ file, codec: plainFileCodec });
    const entries = captureLogs();
    const result = await store.migrateLegacy(async () => {
      throw new Error("DPAPI 解不开");
    });
    expect(result).toBe("failed");
    expect(store.has("llm")).toBe(false);
    expect(store.error()).toBe(null);
    expect(backups(file)).toHaveLength(1);
    const warns = entries.filter((e) => e.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toContain("无法迁移");
    expect(String(warns[0]!.fields.backup)).toContain(".legacy-");
    expect(entries.filter((e) => e.level === "info")).toEqual([]);
  });

  test("迁移拿到坏 JSON：不覆盖、不抛错，并留下备份", async () => {
    const file = legacyFile();
    const store = createSecretStore({ file, codec: plainFileCodec });
    expect(await store.migrateLegacy(async () => "not json")).toBe("failed");
    expect(store.has("llm")).toBe(false);
    const [backup] = backups(file);
    expect(backup).toBeDefined();
    expect(readFileSync(join(file, "..", backup!)).subarray(0, 3).toString("utf8")).toBe("v10");
  });

  test("平台没有异步解密（macOS）：不尝试、保留备份、WARN 说无法自动迁移", async () => {
    const file = legacyFile();
    const store = createSecretStore({ file, codec: plainFileCodec });
    const entries = captureLogs();
    expect(await store.migrateLegacy(null)).toBe("failed");
    expect(backups(file)).toHaveLength(1);
    const warns = entries.filter((e) => e.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toContain("无法自动迁移");
  });

  test("没有旧密钥：不调用解密、不记任何迁移提示（issue #71）", async () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ version: 2, llm: "sk-current" }));
    const store = createSecretStore({ file, codec: plainFileCodec });
    const entries = captureLogs();
    let calls = 0;
    expect(
      await store.migrateLegacy(async () => {
        calls += 1;
        return "";
      }),
    ).toBe("none");
    expect(calls).toBe(0);
    expect(entries).toEqual([]);
    expect(store.get("llm")).toBe("sk-current");
  });

  test("空文件 / 乱码不是旧版密文：按「内容无法识别」备份重置，不发起迁移", async () => {
    for (const content of [Buffer.alloc(0), Buffer.from("\uFEFF"), Buffer.from("garbage-bytes")]) {
      const file = tempFile();
      writeFileSync(file, content);
      const entries = captureLogs();
      const store = createSecretStore({ file, codec: plainFileCodec });
      expect(store.error()).toBe(null);
      expect(store.all()).toEqual([]);
      let calls = 0;
      expect(
        await store.migrateLegacy(async () => {
          calls += 1;
          return "";
        }),
      ).toBe("none");
      expect(calls).toBe(0);
      const warns = entries.filter((e) => e.level === "warn");
      expect(warns).toHaveLength(1);
      expect(warns[0]!.message).toBe("密钥文件内容无法识别，已备份并重置");
      expect(entries.some((e) => e.message.includes("迁移"))).toBe(false);
      expect(backups(file)).toHaveLength(1);
      expect(readFileSync(join(file, "..", backups(file)[0]!))).toEqual(content);
    }
  });
});
