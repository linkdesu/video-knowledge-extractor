import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAsr, parseStart } from "./extract-worker";

// 临时 VNOTE_HOME / VNOTE_USER_DATA：本测试不写盘，但保持与其它 main 测试一致的隔离约定
let envDir: string | undefined;
let prevHome: string | undefined;
let prevUserData: string | undefined;

beforeAll(() => {
  envDir = mkdtempSync(join(tmpdir(), "vnote-worker-"));
  prevHome = process.env.VNOTE_HOME;
  prevUserData = process.env.VNOTE_USER_DATA;
  process.env.VNOTE_HOME = join(envDir, "home");
  process.env.VNOTE_USER_DATA = join(envDir, "user-data");
});

afterAll(() => {
  if (envDir !== undefined) rmSync(envDir, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.VNOTE_HOME;
  else process.env.VNOTE_HOME = prevHome;
  if (prevUserData === undefined) delete process.env.VNOTE_USER_DATA;
  else process.env.VNOTE_USER_DATA = prevUserData;
});

/** 完整启动消息的公共骨架；测试按需改 asr/endpoint。 */
function baseStart(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "start",
    kind: "extract",
    videoId: "vid-1",
    videoPath: "/videos/a.mp4",
    outputDir: "/out/a",
    notesRoot: "/notes",
    cacheRoot: "/cache",
    modelDir: "/models",
    runToken: "tok-1",
    endpoint: { baseUrl: "https://llm.test", apiKey: "llm-key", model: "m" },
    asr: { provider: "local", modelDir: "/models" },
    ...over,
  };
}

const API_KEY = "volc-api-key-secret-123";
const APP_KEY = "volc-app-key-secret-456";
const ACCESS_KEY = "volc-access-key-secret-789";
const OPENAI_KEY = "openai-key-secret-999";

describe("parseAsr", () => {
  test("local：provider 与 modelDir 透传", () => {
    const r = parseAsr({ asr: { provider: "local", modelDir: "/models" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config).toEqual({ provider: "local", modelDir: "/models" });
  });

  test("openai：baseUrl/model/apiKey 透传", () => {
    const r = parseAsr({ asr: { provider: "openai", baseUrl: "https://asr.test", model: "gpt-4o-transcribe", apiKey: OPENAI_KEY } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config).toEqual({ provider: "openai", baseUrl: "https://asr.test", model: "gpt-4o-transcribe", apiKey: OPENAI_KEY });
  });

  test("openai：缺 apiKey 报中文错误", () => {
    const r = parseAsr({ asr: { provider: "openai", baseUrl: "https://asr.test", model: "m" } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("OpenAI ASR 缺少 base url、模型或 api key");
  });

  test("volcengine flash + apiKey 鉴权：engine id 保持 volcengine", () => {
    const r = parseAsr({ asr: { provider: "volcengine", mode: "flash", auth: { kind: "apiKey", apiKey: API_KEY } } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.provider).toBe("volcengine");
    expect(r.config).toEqual({ provider: "volcengine", mode: "flash", auth: { kind: "apiKey", apiKey: API_KEY } });
  });

  test("volcengine standard + appAccessKey 鉴权：engine id 保持 volcengine", () => {
    const r = parseAsr({ asr: { provider: "volcengine", mode: "standard", auth: { kind: "appAccessKey", appKey: APP_KEY, accessKey: ACCESS_KEY } } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.provider).toBe("volcengine");
    expect(r.config).toEqual({ provider: "volcengine", mode: "standard", auth: { kind: "appAccessKey", appKey: APP_KEY, accessKey: ACCESS_KEY } });
  });

  test("volcengine：缺 mode 报错，错误不含 key", () => {
    const r = parseAsr({ asr: { provider: "volcengine", auth: { kind: "apiKey", apiKey: API_KEY } } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("火山 ASR 缺少或包含无效的版本（flash / standard）");
    expect(r.error).not.toContain(API_KEY);
  });

  test("volcengine flash：缺 apiKey 报错，错误不含 key", () => {
    const r = parseAsr({ asr: { provider: "volcengine", mode: "flash", auth: { kind: "apiKey", apiKey: "" } } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("火山 ASR 缺少 API Key");
    expect(r.error).not.toContain(API_KEY);
  });

  test("volcengine：缺 auth 块报错", () => {
    const r = parseAsr({ asr: { provider: "volcengine", mode: "flash" } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("火山 ASR 缺少鉴权配置");
  });

  test("volcengine：appAccessKey 缺 accessKey 报错，错误不含 key", () => {
    const r = parseAsr({ asr: { provider: "volcengine", mode: "standard", auth: { kind: "appAccessKey", appKey: APP_KEY } } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("火山 ASR 缺少 App Key 或 Access Key");
    expect(r.error).not.toContain(APP_KEY);
  });

  test("volcengine：未知鉴权 kind 报错，错误不含 key", () => {
    const r = parseAsr({ asr: { provider: "volcengine", mode: "flash", auth: { kind: "oauth", token: API_KEY } } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("火山 ASR 缺少或包含无效的鉴权方式（apiKey / appAccessKey）");
    expect(r.error).not.toContain(API_KEY);
  });

  test("未知 provider 报错", () => {
    const r = parseAsr({ asr: { provider: "whisper" } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("ASR 提供方无效");
  });

  test("缺 asr 字段报错", () => {
    const r = parseAsr({});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("ASR 配置缺失");
  });
});

describe("parseStart", () => {
  test("完整消息解析成功，asr 透传", () => {
    const r = parseStart(baseStart({ asr: { provider: "volcengine", mode: "flash", auth: { kind: "apiKey", apiKey: API_KEY } } }));
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.start.asr).toEqual({ provider: "volcengine", mode: "flash", auth: { kind: "apiKey", apiKey: API_KEY } });
    expect(r.start.endpoint).toEqual({ baseUrl: "https://llm.test", apiKey: "llm-key", model: "m" });
  });

  test("start 类型缺失报错", () => {
    const r = parseStart({ ...baseStart(), type: "nope" });
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toBe("启动消息格式无效");
  });

  test("缺 runToken 报错", () => {
    const r = parseStart(baseStart({ runToken: "" }));
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toBe("运行 token 缺失");
  });

  test("缺 endpoint 报错", () => {
    const msg = baseStart();
    delete msg.endpoint;
    const r = parseStart(msg);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toBe("LLM 端点缺失");
  });

  test("asr 解析失败回错误消息而不是静默忽略", () => {
    const r = parseStart(baseStart({ asr: { provider: "volcengine", mode: "flash", auth: { kind: "apiKey", apiKey: "" } } }));
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.message).toBe("火山 ASR 缺少 API Key");
    expect(r.message).not.toContain(API_KEY);
  });

  test("notes 任务缺 topicIds 时归一为空数组", () => {
    const r = parseStart(baseStart({ kind: "notes" }));
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.start.topicIds).toEqual([]);
  });
});
