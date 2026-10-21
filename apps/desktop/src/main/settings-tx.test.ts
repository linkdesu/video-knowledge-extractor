import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretStore, type SecretCodec, type SecretStore } from "./secrets";
import { commitCredentialUpdate, replayCredentialTransaction } from "./settings-tx";

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

type World = {
  userData: string;
  settingsFile: string;
  codec: SecretCodec;
  secretStore: SecretStore;
};

function makeWorld(): World {
  const dir = mkdtempSync(join(tmpdir(), "vnote-tx-"));
  const settingsFile = join(dir, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ version: 2, notesRoot: dir }));
  return {
    userData: dir,
    settingsFile,
    codec: fakeCodec(),
    secretStore: createSecretStore({ file: join(dir, "secrets.bin"), codec: fakeCodec() }),
  };
}

function pendingPath(w: World): string {
  return join(w.userData, "secrets.pending");
}

function writePending(w: World, body: unknown): void {
  writeFileSync(pendingPath(w), w.codec.encrypt(JSON.stringify(body)));
}

describe("commitCredentialUpdate", () => {
  test("正常：settings 落盘、密钥入库、pending 删除", () => {
    const w = makeWorld();
    commitCredentialUpdate({
      ...w,
      settingsPatch: { llm: { baseUrl: "https://a.example" } },
      secret: { id: "llm", patch: { apiKey: "k-new" } },
    });
    expect(readFileSync(w.settingsFile, "utf8")).toContain("https://a.example");
    expect(w.secretStore.get("llm")).toBe("k-new");
    expect(() => readFileSync(pendingPath(w), "utf8")).toThrow();
  });

  test("纯端点更新不带密钥动作：已存 key 保持", () => {
    const w = makeWorld();
    w.secretStore.set("llm", "existing");
    commitCredentialUpdate({
      ...w,
      settingsPatch: { llm: { model: "m-1" } },
      secret: { id: "llm", patch: {} },
    });
    expect(w.secretStore.get("llm")).toBe("existing");
  });

  test("apiKey 与 clearApiKey 同传直接拒绝，不写任何文件", () => {
    const w = makeWorld();
    expect(() =>
      commitCredentialUpdate({ ...w, settingsPatch: {}, secret: { id: "llm", patch: { apiKey: "x", clearApiKey: true } } }),
    ).toThrow("不能同时保存和清除 API key");
    expect(() => readFileSync(pendingPath(w), "utf8")).toThrow();
  });

  test("存储不可用时带 apiKey 的更新被拒绝", () => {
    const w = makeWorld();
    const store: SecretStore = {
      available: () => false,
      has: () => false,
      get: () => undefined,
      set: () => undefined,
      clear: () => undefined,
      all: () => [],
      error: () => null,
    };
    expect(() =>
      commitCredentialUpdate({ ...w, secretStore: store, settingsPatch: {}, secret: { id: "asr", patch: { apiKey: "x" } } }),
    ).toThrow("系统密钥存储不可用");
    expect(() => readFileSync(pendingPath(w), "utf8")).toThrow();
  });

  test("两次写之间崩溃（只写 pending）后启动重放：补齐 settings 与密钥，删 pending，重放幂等", () => {
    const w = makeWorld();
    writePending(w, {
      txId: "tx-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      settings: { llm: { baseUrl: "https://b.example" } },
      secret: { id: "llm", kind: "set", value: "k-pending" },
    });
    const err = replayCredentialTransaction(w);
    expect(err).toBe(null);
    expect(readFileSync(w.settingsFile, "utf8")).toContain("https://b.example");
    expect(w.secretStore.get("llm")).toBe("k-pending");
    expect(() => readFileSync(pendingPath(w), "utf8")).toThrow();
    expect(replayCredentialTransaction(w)).toBe(null);
  });

  test("重放失败（saveSettings 拒绝）：保留 pending、settings 保持旧值、错误可暴露给设置页", () => {
    const w = makeWorld();
    writePending(w, {
      txId: "tx-2",
      createdAt: "2026-01-01T00:00:00.000Z",
      settings: { llm: { baseUrl: "https://c.example" } },
      secret: { id: "llm", kind: "set", value: "k-asr" },
    });
    // env 锁定 llm.baseUrl：core saveSettings 拒绝该 patch
    const prev = process.env.VNOTE_LLM_BASE_URL;
    process.env.VNOTE_LLM_BASE_URL = "https://env.example";
    try {
      const err = replayCredentialTransaction(w);
      expect(err).toContain("未完成的凭据更新");
      expect(readFileSync(w.settingsFile, "utf8")).not.toContain("https://c.example");
      expect(readFileSync(pendingPath(w), "utf8")).toContain("enc:");
    } finally {
      if (prev === undefined) delete process.env.VNOTE_LLM_BASE_URL;
      else process.env.VNOTE_LLM_BASE_URL = prev;
    }
  });

  test("pending 解密失败：保留原文件并返回可读错误", () => {
    const w = makeWorld();
    writeFileSync(pendingPath(w), Buffer.from("garbage"));
    const err = replayCredentialTransaction({ ...w, codec: fakeCodec("nope") });
    expect(err).toContain("解密失败");
    expect(readFileSync(pendingPath(w), "utf8")).toBe("garbage");
  });
});
