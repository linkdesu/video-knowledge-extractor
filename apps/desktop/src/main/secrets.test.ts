import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretStore, type SecretCodec } from "./secrets";
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

describe("createSecretStore", () => {
  test("加密往返：set 后落盘的是 codec 密文，重载后 get/has 一致", () => {
    const file = tempFile();
    const store = createSecretStore({ file, codec: fakeCodec() });
    store.set("llm", "k1");
    const cipher = readFileSync(file, "utf8");
    expect(cipher.startsWith("enc:")).toBe(true);
    expect(cipher).toContain('"llm":"k1"');
    expect(JSON.parse(fakeCodec().decrypt(Buffer.from(cipher, "utf8")))).toEqual({ version: 1, llm: "k1" });
    const again = createSecretStore({ file, codec: fakeCodec() });
    expect(again.has("llm")).toBe(true);
    expect(again.get("llm")).toBe("k1");
    expect(again.has("asr")).toBe(false);
    expect(again.all()).toEqual(["k1"]);
  });

  test("文件权限 0o600", () => {
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
    expect(JSON.parse(fakeCodec().decrypt(readFileSync(file)))).toEqual({ version: 1, llm: "new" });
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
    expect(() => s2.set("llm", "y")).toThrow("系统密钥存储不可用");
  });

  test("all 只返回已存值，给脱敏用", () => {
    const file = tempFile();
    const store = createSecretStore({ file, codec: fakeCodec() });
    store.set("llm", "llm-key");
    store.set("asr", "asr-key");
    expect([...store.all()].sort()).toEqual(["asr-key", "llm-key"]);
    store.clear("llm");
    expect(store.all()).toEqual(["asr-key"]);
  });
});
