import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function readPendingBody(w: World): Record<string, unknown> {
  return JSON.parse(w.codec.decrypt(readFileSync(pendingPath(w)))) as Record<string, unknown>;
}

function readSettings(w: World): Record<string, unknown> {
  return JSON.parse(readFileSync(w.settingsFile, "utf8")) as Record<string, unknown>;
}

let envDir: string;
let prevHome: string | undefined;
let prevUserData: string | undefined;

beforeEach(() => {
  prevHome = process.env.VNOTE_HOME;
  prevUserData = process.env.VNOTE_USER_DATA;
  envDir = mkdtempSync(join(tmpdir(), "vnote-tx-env-"));
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
      // 非法 base url：core 的 saveSettings 校验拒绝这笔 pending
      settings: { llm: { baseUrl: "not-a-url" } },
      secret: { id: "llm", kind: "set", value: "k-asr" },
    });
    const err = replayCredentialTransaction(w);
    expect(err).toContain("未完成的凭据更新");
    expect(readFileSync(w.settingsFile, "utf8")).not.toContain("not-a-url");
    expect(readFileSync(pendingPath(w), "utf8")).toContain("enc:");
  });

  test("pending 解密失败：保留原文件并返回可读错误", () => {
    const w = makeWorld();
    writeFileSync(pendingPath(w), Buffer.from("garbage"));
    const err = replayCredentialTransaction({ ...w, codec: fakeCodec("nope") });
    expect(err).toContain("解密失败");
    expect(readFileSync(pendingPath(w), "utf8")).toBe("garbage");
  });

  test("新提交前先重放旧 pending：两笔都生效，旧记录不被覆盖丢失", () => {
    const w = makeWorld();
    writePending(w, {
      txId: "tx-old",
      createdAt: "2026-01-01T00:00:00.000Z",
      settings: { llm: { baseUrl: "https://old.example" } },
      secret: { id: "llm", kind: "set", value: "old-key" },
    });
    commitCredentialUpdate({
      ...w,
      settingsPatch: { asr: { openai: { baseUrl: "https://new.example" } } },
      secret: { id: "volcApiKey", patch: { apiKey: "new-key" } },
    });
    const settings = readSettings(w);
    expect(settings.llm).toEqual({ baseUrl: "https://old.example" });
    expect((settings.asr as Record<string, unknown>).openai).toEqual({ baseUrl: "https://new.example" });
    expect(w.secretStore.get("llm")).toBe("old-key");
    expect(w.secretStore.get("volcApiKey")).toBe("new-key");
    expect(() => readFileSync(pendingPath(w), "utf8")).toThrow();
  });

  test("旧 pending 重放失败时新提交被拒绝，pending 原样保留、新密钥不写入", () => {
    const w = makeWorld();
    writePending(w, {
      txId: "tx-old",
      createdAt: "2026-01-01T00:00:00.000Z",
      // 非法 base url：core 的 saveSettings 校验拒绝这笔 pending
      settings: { llm: { baseUrl: "not-a-url" } },
      secret: { id: "llm", kind: "set", value: "old-key" },
    });
    expect(() =>
      commitCredentialUpdate({
        ...w,
        settingsPatch: { asr: { openai: { baseUrl: "https://new.example" } } },
        secret: { id: "volcApiKey", patch: { apiKey: "new-key" } },
      }),
    ).toThrow("未完成的凭据更新");
    const body = readPendingBody(w);
    expect(body.txId).toBe("tx-old");
    expect(body.settings).toEqual({ llm: { baseUrl: "not-a-url" } });
    expect(w.secretStore.get("volcApiKey")).toBeUndefined();
    expect(readFileSync(w.settingsFile, "utf8")).not.toContain("https://new.example");
  });

  test("非法 baseUrl：校验在写任何文件之前拒绝，不写 pending、不动 settings 与密钥；修正后成功", () => {
    const w = makeWorld();
    w.secretStore.set("llm", "kept");
    const before = readSettings(w);
    expect(() =>
      commitCredentialUpdate({ ...w, settingsPatch: { llm: { baseUrl: "api.example.com" } }, secret: { id: "llm", patch: { apiKey: "k-bad" } } }),
    ).toThrow("必须是 http(s) 绝对 URL");
    expect(() => readFileSync(pendingPath(w), "utf8")).toThrow();
    expect(readSettings(w)).toEqual(before);
    expect(w.secretStore.get("llm")).toBe("kept");
    // 修正后成功
    commitCredentialUpdate({
      ...w,
      settingsPatch: { llm: { baseUrl: "https://ok.example" } },
      secret: { id: "llm", patch: { apiKey: "k-new" } },
    });
    expect((readSettings(w).llm as Record<string, unknown>).baseUrl).toBe("https://ok.example");
    expect(w.secretStore.get("llm")).toBe("k-new");
    // 全新重放报告无 pending
    expect(replayCredentialTransaction(w)).toBe(null);
  });
});

describe("pending v2 设置规范化", () => {
  test("只有 provider: remote → openai", () => {
    const w = makeWorld();
    writePending(w, {
      txId: "tx-p",
      createdAt: "2026-01-01T00:00:00.000Z",
      settings: { asr: { provider: "remote" } },
      secret: { id: "asr", kind: "none" },
    });
    expect(replayCredentialTransaction(w)).toBe(null);
    expect((readSettings(w).asr as Record<string, unknown>).provider).toBe("openai");
  });

  test("只有 asr.remote 块 → asr.openai 块，legacy 键被丢弃", () => {
    const w = makeWorld();
    writePending(w, {
      txId: "tx-r",
      createdAt: "2026-01-01T00:00:00.000Z",
      settings: { asr: { remote: { baseUrl: "https://r.example/v1", model: "qwen3-asr" } } },
      secret: { id: "asr", kind: "none" },
    });
    expect(replayCredentialTransaction(w)).toBe(null);
    const asr = readSettings(w).asr as Record<string, unknown>;
    expect(asr.openai).toEqual({ baseUrl: "https://r.example/v1", model: "qwen3-asr" });
    expect("remote" in asr).toBe(false);
  });

  test("provider: remote 与 asr.remote 同时存在时一起转换", () => {
    const w = makeWorld();
    writePending(w, {
      txId: "tx-c",
      createdAt: "2026-01-01T00:00:00.000Z",
      settings: { asr: { provider: "remote", remote: { model: "qwen3-asr" } } },
      secret: { id: "asr", kind: "none" },
    });
    expect(replayCredentialTransaction(w)).toBe(null);
    const asr = readSettings(w).asr as Record<string, unknown>;
    expect(asr.provider).toBe("openai");
    expect(asr.openai).toEqual({ model: "qwen3-asr" });
    expect("remote" in asr).toBe(false);
  });

  test("已有 asr.openai 时以它为准，忽略 asr.remote", () => {
    const w = makeWorld();
    writePending(w, {
      txId: "tx-w",
      createdAt: "2026-01-01T00:00:00.000Z",
      settings: { asr: { provider: "remote", remote: { model: "legacy-model" }, openai: { model: "modern-model" } } },
      secret: { id: "asr", kind: "none" },
    });
    expect(replayCredentialTransaction(w)).toBe(null);
    const asr = readSettings(w).asr as Record<string, unknown>;
    expect(asr.provider).toBe("openai");
    expect(asr.openai).toEqual({ model: "modern-model" });
    expect("remote" in asr).toBe(false);
  });
});

describe("pending 接受新增的密钥 id", () => {
  test("volcApiKey / volcAppKey / volcAccessKey 都能重放", () => {
    for (const id of ["volcApiKey", "volcAppKey", "volcAccessKey"] as const) {
      const w = makeWorld();
      writePending(w, {
        txId: `tx-${id}`,
        createdAt: "2026-01-01T00:00:00.000Z",
        settings: {},
        secret: { id, kind: "set", value: `value-${id}` },
      });
      expect(replayCredentialTransaction(w)).toBe(null);
      expect(w.secretStore.get(id)).toBe(`value-${id}`);
      expect(() => readFileSync(pendingPath(w), "utf8")).toThrow();
    }
  });

  test("未知 id 仍按不完整记录拒绝并保留原文件", () => {
    const w = makeWorld();
    writePending(w, {
      txId: "tx-bad",
      createdAt: "2026-01-01T00:00:00.000Z",
      settings: {},
      secret: { id: "unknownKey", kind: "set", value: "x" },
    });
    const err = replayCredentialTransaction(w);
    expect(err).toContain("不完整");
    expect(readFileSync(pendingPath(w), "utf8")).toContain("enc:");
  });
});
