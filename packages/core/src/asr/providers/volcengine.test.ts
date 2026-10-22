import { afterAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteEngine, createUrlEngine } from "../remote";
type Req = { url: string; headers: Record<string, string>; body: Buffer };
type Resp = { status: number; body: string; headers?: Record<string, string> };

function startVolcMock(handler: (rec: Req) => Resp): { url: string; calls: Req[] } {
  const calls: Req[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      const rec: Req = { url: req.url, headers, body: Buffer.from(await req.arrayBuffer()) };
      calls.push(rec);
      const r = handler(rec);
      return new Response(r.body, { status: r.status, headers: r.headers });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, calls };
}

/** 守卫：任何不指向 mock 的请求立即失败，测试绝不出真实网络（ADR-0016 §2 端点注入）。 */
function mockFetch(base: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(base)) throw new Error(`测试请求越界（只允许 ${base}）：${url}`);
    return fetch(input, init);
  }) as typeof fetch;
}
import {
  createVolcengineFlashProvider,
  createVolcengineStandardProvider,
  VOLC_MAX_UPLOAD_BYTES,
} from "./volcengine";
import type { Progress } from "../../core/steps";
import type { AsrRun } from "../engine";
import type { Video, SpeakerId } from "../../core/types";

const SR = 16000;
const API_KEY = "volc-api-key-secret-1";
const APP_KEY = "volc-app-key-secret-2";
const ACCESS_KEY = "volc-access-key-secret-3";

const servers: Server<undefined>[] = [];
const savedEnv: Record<string, string | undefined> = {};

afterAll(() => {
  for (const s of servers) s.stop(true);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** VNOTE_HOME / VNOTE_USER_DATA 指向临时目录（ADR-0016 §12），结束时恢复 env。 */
function freshEnv(): void {
  for (const k of ["VNOTE_HOME", "VNOTE_USER_DATA"]) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    process.env[k] = mkdtempSync(join(tmpdir(), `vnote-${k.toLowerCase()}-`));
  }
}

/** 每个测试自建临时目录（ADR-0015 约定）。 */
function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "vnote-volc-"));
}

/**
 * 写 0.2Hz 正弦 wav（16k 单声道 16-bit PCM）：周期恰为 5 秒，
 * 硬切 5 秒块 1 与块 2 的 PCM 完全相同；幅值远离静音阈值，silencedetect 不产生停顿。
 */
function writeSineWav(path: string, seconds: number): void {
  const n = seconds * SR;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(0.5 * Math.sin((2 * Math.PI * 0.2 * i) / SR) * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}


/** 引擎跑一次火山极速版（wav 直传，不编码）。 */
async function runFlash(
  url: string,
  dir: string,
  seconds: number,
  limits: { target: number; min: number; max: number; hardMax: boolean },
  auth: { kind: "apiKey"; apiKey: string } | { kind: "appAccessKey"; appKey: string; accessKey: string },
  fetchImpl?: typeof fetch,
): Promise<{ run: AsrRun; progress: Progress[] }> {
  const wavPath = `${dir}/in.wav`;
  writeSineWav(wavPath, seconds);
  const engine = createRemoteEngine(
    createVolcengineFlashProvider(auth, { endpoint: `${url}/recognize/flash` }),
    { chunkLimits: limits, fetchImpl: fetchImpl ?? mockFetch(url) },
  );
  const progress: Progress[] = [];
  const video: Video = {
    id: "vid-volc" as Video["id"],
    title: "t",
    sourcePath: wavPath,
    durationSeconds: seconds,
    outputDir: dir,
  };
  const run = await engine.run({ video, wavPath, cacheDir: dir, onProgress: (p) => progress.push(p) });
  return { run, progress };
}

/** 标准版走 createUrlEngine（ADR-0016 §6），缺 URL 与 URL 用例都在这里。 */
async function runStandard(
  dir: string,
  url: string,
  sourceUrl: string | undefined,
  pollIntervalMs?: number,
  maxTotalMs?: number,
): Promise<{ err: Error | undefined; run: AsrRun | undefined }> {
  const engine = createUrlEngine(
    createVolcengineStandardProvider(
      { kind: "apiKey", apiKey: API_KEY },
      { submitUrl: `${url}/submit`, queryUrl: `${url}/query`, pollIntervalMs, maxTotalMs },
    ),
    { fetchImpl: mockFetch(url) },
  );
  const video: Video = {
    id: "vid-volc" as Video["id"],
    title: "t",
    sourcePath: "",
    durationSeconds: 10,
    outputDir: dir,
  };
  try {
    const run = await engine.run({ video, wavPath: "", cacheDir: dir, sourceUrl });
    return { err: undefined, run };
  } catch (e) {
    return { err: e as Error, run: undefined };
  }
}

const ONE_CHUNK = { target: 8, min: 6, max: 10, hardMax: true };
const TWO_CHUNKS = { target: 4, min: 3, max: 5, hardMax: true };

function volcBody(utterances: unknown, text = ""): string {
  return JSON.stringify({ result: { text, ...(utterances === undefined ? {} : { utterances }) } });
}

/** 成功响应（标准版多 audio_info）。 */
function volcSuccess(utterancesMs: { start: number; end: number; text: string }[], durationMs = 30_000, text = ""): string {
  return JSON.stringify({
    audio_info: { duration: durationMs },
    result: { text, utterances: utterancesMs.map((u) => ({ start_time: u.start, end_time: u.end, text: u.text })) },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("火山极速版 flash（Bun.serve mock）", () => {
  test("apiKey 鉴权：X-Api-Key 头、resource id、UUID request id、show_utterances、base64 还原为 WAV 切片", async () => {
    freshEnv();
    const { url, calls } = startVolcMock(() => ({
      status: 200,
      headers: { "X-Api-Status-Code": "20000000" },
      body: volcBody([{ start_time: 1000, end_time: 2000, text: "你好" }]),
    }));
    const dir = freshDir();
    const wavPath = `${dir}/in.wav`;
    writeSineWav(wavPath, 8);
    const { run, progress } = await runFlash(url, dir, 8, ONE_CHUNK, { kind: "apiKey", apiKey: API_KEY });
    expect(calls.length).toBe(1);
    const rec = calls[0];
    expect(rec?.headers["x-api-key"]).toBe(API_KEY);
    expect(rec?.headers["x-api-app-key"]).toBeUndefined();
    expect(rec?.headers["x-api-access-key"]).toBeUndefined();
    expect(rec?.headers["x-api-resource-id"]).toBe("volc.bigasr.auc_turbo");
    expect(UUID_RE.test(rec?.headers["x-api-request-id"] ?? "")).toBe(true);
    expect(rec?.headers["x-api-sequence"]).toBe("-1");
    const body = JSON.parse(rec?.body.toString("utf8") ?? "{}") as Record<string, Record<string, unknown>>;
    expect(body.user?.uid).toBe("video-notes");
    expect(body.audio?.format).toBe("wav");
    expect(body.request?.show_utterances).toBe(true);
    const data = body.audio?.data as string | undefined;
    expect(typeof data).toBe("string");
    const wav = Buffer.from(data ?? "", "base64");
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    // 切片由共享管线做：44 字节头 + 8 秒 16k 16bit 单声道 PCM（ffmpeg 可能附加元数据，只校验前缀与长度下限）。
    expect(wav.length).toBeGreaterThanOrEqual(44 + 8 * SR * 2);
    const { run: second } = await runFlash(url, dir, 8, ONE_CHUNK, { kind: "apiKey", apiKey: API_KEY });
    expect(calls.length).toBe(1); // 二次运行全走缓存
    expect(second.cacheHits.length).toBe(1);
    expect(run.engine).toBe("volcengine");
    expect(run.modelId).toBe("volc.bigasr.auc_turbo");
    expect(run.transcript.utterances).toEqual([{ start: 1, end: 2, speakerId: "speaker-1" as SpeakerId, text: "你好" }]);
    expect(run.transcript.speakers).toEqual([{ id: "speaker-1" as SpeakerId, name: "说话人1", color: "#6aa9ff" }]);
    expect(progress.length).toBe(1);
  });

  test("appAccessKey 鉴权：X-Api-App-Key + X-Api-Access-Key 头，uid 用 appKey", async () => {
    freshEnv();
    const { url, calls } = startVolcMock(() => ({
      status: 200,
      headers: { "X-Api-Status-Code": "20000000" },
      body: volcBody([{ start_time: 1000, end_time: 2000, text: "ok" }]),
    }));
    const dir = freshDir();
    await runFlash(url, dir, 8, ONE_CHUNK, { kind: "appAccessKey", appKey: APP_KEY, accessKey: ACCESS_KEY });
    const rec = calls[0];
    expect(rec?.headers["x-api-app-key"]).toBe(APP_KEY);
    expect(rec?.headers["x-api-access-key"]).toBe(ACCESS_KEY);
    expect(rec?.headers["x-api-key"]).toBeUndefined();
    const body = JSON.parse(rec?.body.toString("utf8") ?? "{}") as Record<string, unknown>;
    expect((body.user as Record<string, unknown>)?.uid).toBe(APP_KEY);
  });

  test("块偏移：10 秒两块 [0,5][5,10]，块2 时间加块起点平移，同 PCM 走缓存", async () => {
    freshEnv();
    const { url, calls } = startVolcMock(() => ({
      status: 200,
      headers: { "X-Api-Status-Code": "20000000" },
      body: volcBody([{ start_time: 1000, end_time: 2000, text: "你好" }]),
    }));
    const dir = freshDir();
    const { run } = await runFlash(url, dir, 10, TWO_CHUNKS, { kind: "apiKey", apiKey: API_KEY });
    expect(run.chunks.map((c) => [c.start, c.end])).toEqual([[0, 5], [5, 10]]);
    // 块1 与块2 PCM 相同（0.2Hz 正弦周期 5 秒）：块2 命中缓存，只发一次请求。
    expect(calls.length).toBe(1);
    expect(run.cacheHits).toEqual(["chunk-2"]);
    expect(run.transcript.utterances).toEqual([
      { start: 1, end: 2, speakerId: "speaker-1" as SpeakerId, text: "你好" },
      { start: 6, end: 7, speakerId: "speaker-1" as SpeakerId, text: "你好" },
    ]);
  });

  test("静音 20000003：合法空结果，写空缓存（二次运行不再请求）", async () => {
    freshEnv();
    const { url, calls } = startVolcMock(() => ({
      status: 200,
      headers: { "X-Api-Status-Code": "20000003" },
      body: "",
    }));
    const dir = freshDir();
    const first = await runFlash(url, dir, 8, ONE_CHUNK, { kind: "apiKey", apiKey: API_KEY });
    expect(calls.length).toBe(1);
    expect(first.run.transcript.utterances).toEqual([]);
    const second = await runFlash(url, dir, 8, ONE_CHUNK, { kind: "apiKey", apiKey: API_KEY });
    expect(calls.length).toBe(1);
    expect(second.run.cacheHits).toEqual(["chunk-1"]);
  });

  test("text 非空但无 utterances：报「不返回逐句时间戳」，不写缓存", async () => {
    freshEnv();
    const { url, calls } = startVolcMock(() => ({
      status: 200,
      headers: { "X-Api-Status-Code": "20000000" },
      body: volcBody(undefined, "只有整段文本"),
    }));
    const dir = freshDir();
    let err: Error | undefined;
    try {
      await runFlash(url, dir, 8, ONE_CHUNK, { kind: "apiKey", apiKey: API_KEY });
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toBe("该端点不返回逐句时间戳，不能用于字幕");
    expect(calls.length).toBe(1);
    expect(() => readdirSync(`${dir}/transcribe`)).toThrow(); // 未写缓存
  });

  test("401：不重试，错误含 401 与脱敏，不含 key", async () => {
    freshEnv();
    const { url, calls } = startVolcMock(() => ({
      status: 401,
      headers: { "X-Api-Status-Code": "20000000" }, // 顺序 1：即使带成功头也按 HTTP 失败。
      body: JSON.stringify({ message: `bad key ${API_KEY}` }),
    }));
    const dir = freshDir();
    let err: Error | undefined;
    try {
      await runFlash(url, dir, 8, ONE_CHUNK, { kind: "apiKey", apiKey: API_KEY });
    } catch (e) {
      err = e as Error;
    }
    expect(calls.length).toBe(1);
    expect(err?.message).toContain("401");
    expect(err?.message).toContain("[redacted]");
    expect(err?.message).not.toContain(API_KEY);
  });

  test("55000031：重试一次后仍失败则报错", async () => {
    freshEnv();
    let n = 0;
    const { url, calls } = startVolcMock(() => {
      n += 1;
      return {
        status: 200,
        headers: { "X-Api-Status-Code": "55000031" },
        body: JSON.stringify({ message: "busy" }),
      };
    });
    const dir = freshDir();
    let err: Error | undefined;
    try {
      await runFlash(url, dir, 8, ONE_CHUNK, { kind: "apiKey", apiKey: API_KEY });
    } catch (e) {
      err = e as Error;
    }
    expect(calls.length).toBe(2);
    expect(err?.message).toContain("55000031");
    expect(() => readdirSync(`${dir}/transcribe`)).toThrow(); // 失败不写缓存
  });

  test("550 后恢复：首次 55000031，重试 200 成功", async () => {
    freshEnv();
    let n = 0;
    const { url, calls } = startVolcMock(() => {
      n += 1;
      return n === 1
        ? { status: 200, headers: { "X-Api-Status-Code": "55000031" }, body: "{}" }
        : { status: 200, headers: { "X-Api-Status-Code": "20000000" }, body: volcBody([{ start_time: 1000, end_time: 2000, text: "ok" }]) };
    });
    const dir = freshDir();
    const { run } = await runFlash(url, dir, 8, ONE_CHUNK, { kind: "apiKey", apiKey: API_KEY });
    expect(calls.length).toBe(2);
    expect(run.transcript.utterances).toEqual([{ start: 1, end: 2, speakerId: "speaker-1" as SpeakerId, text: "ok" }]);
  });

  test("HTTP 500（带成功头）：可重试，重试后成功", async () => {
    freshEnv();
    let n = 0;
    const { url, calls } = startVolcMock(() => {
      n += 1;
      return n === 1
        ? { status: 500, headers: { "X-Api-Status-Code": "20000000" }, body: "boom" }
        : { status: 200, headers: { "X-Api-Status-Code": "20000000" }, body: volcBody([{ start_time: 1000, end_time: 2000, text: "ok" }]) };
    });
    const dir = freshDir();
    const { run } = await runFlash(url, dir, 8, ONE_CHUNK, { kind: "apiKey", apiKey: API_KEY });
    expect(calls.length).toBe(2);
    expect(run.transcript.utterances).toEqual([{ start: 1, end: 2, speakerId: "speaker-1" as SpeakerId, text: "ok" }]);
  });

  test("网络错误：第一次 fetch 抛 TypeError，重试后成功", async () => {
    freshEnv();
    let n = 0;
    const { url, calls } = startVolcMock(() => {
      n += 1;
      return {
        status: 200,
        headers: { "X-Api-Status-Code": "20000000" },
        body: volcBody([{ start_time: 1000, end_time: 2000, text: "ok" }]),
      };
    });
    const dir = freshDir();
    const okFetch = mockFetch(url);
    let flaky = true;
    let clientCalls = 0;
    const { run } = await runFlash(
      url,
      dir,
      8,
      ONE_CHUNK,
      { kind: "apiKey", apiKey: API_KEY },
      ((input, init) => {
        clientCalls += 1;
        return flaky ? ((flaky = false), Promise.reject(new TypeError("fetch failed"))) : okFetch(input, init);
      }) as typeof fetch,
    );
    expect(clientCalls).toBe(2);
    expect(calls.length).toBe(1);
    expect(run.transcript.utterances).toEqual([{ start: 1, end: 2, speakerId: "speaker-1" as SpeakerId, text: "ok" }]);
  });

  test("HTTP 200 但缺 X-Api-Status-Code：报错不重试", async () => {
    freshEnv();
    const { url, calls } = startVolcMock(() => ({ status: 200, body: "{}" }));
    const dir = freshDir();
    let err: Error | undefined;
    try {
      await runFlash(url, dir, 8, ONE_CHUNK, { kind: "apiKey", apiKey: API_KEY });
    } catch (e) {
      err = e as Error;
    }
    expect(calls.length).toBe(1);
    expect(err?.message).toContain("X-Api-Status-Code");
  });

  test("超过 20 MiB 的块：请求前直接拒绝，不发请求", async () => {
    freshEnv();
    const { url, calls } = startVolcMock(() => ({ status: 200, headers: { "X-Api-Status-Code": "20000000" }, body: "{}" }));
    const provider = createVolcengineFlashProvider({ kind: "apiKey", apiKey: API_KEY });
    void url;
    let err: Error | undefined;
    try {
      await provider.transcribe(
        { bytes: new Uint8Array(VOLC_MAX_UPLOAD_BYTES + 1), fileName: "chunk-1.wav", format: "wav", duration: 300 },
        fetch,
      );
    } catch (e) {
      err = e as Error;
    }
    expect(calls.length).toBe(0);
    expect(err?.message).toContain(String(VOLC_MAX_UPLOAD_BYTES));
  });

  test.each([
    ["非 JSON", "not-json{"],
    ["缺 result", "{}"],
    ["result null", JSON.stringify({ result: null })],
    ["utterances 非数组", volcBody({ a: 1 })],
    ["start_time null", JSON.stringify({ result: { text: "", utterances: [{ start_time: null, end_time: 1, text: "x" }] } })],
    ["start_time 布尔", JSON.stringify({ result: { text: "", utterances: [{ start_time: true, end_time: 1, text: "x" }] } })],
    ["start_time 字符串", JSON.stringify({ result: { text: "", utterances: [{ start_time: "1", end_time: 1, text: "x" }] } })],
    ["text 非字符串", JSON.stringify({ result: { text: 7, utterances: [] } })],
  ])("结构错误（%s）：报结构错误，不写缓存、不重试", async (_name, body) => {
    freshEnv();
    let n = 0;
    const { url, calls } = startVolcMock(() => {
      n += 1;
      return { status: 200, headers: { "X-Api-Status-Code": "20000000" }, body };
    });
    const dir = freshDir();
    let err: Error | undefined;
    try {
      await runFlash(url, dir, 8, ONE_CHUNK, { kind: "apiKey", apiKey: API_KEY });
    } catch (e) {
      err = e as Error;
    }
    expect(n).toBe(1);
    expect(calls.length).toBe(1);
    expect(err?.message).toContain("火山");
    expect(() => readdirSync(`${dir}/transcribe`)).toThrow();
  });
});

describe("火山标准版 standard（Bun.serve mock）", () => {
  test("提交 20000000 → 查询 20000001 → 20000000：完成，绝对时间不加偏移，query 复用同一 UUID", async () => {
    freshEnv();
    let submit = 0;
    let query = 0;
    let submitUuid = "";
    const { url, calls } = startVolcMock((rec) => {
      const isSubmit = rec.url.includes("/submit");
      if (isSubmit) {
        submit += 1;
        submitUuid = rec.headers["x-api-request-id"] ?? "";
        return { status: 200, headers: { "X-Api-Status-Code": "20000000" }, body: "" };
      }
      query += 1;
      expect(rec.headers["x-api-request-id"]).toBe(submitUuid); // 查询复用提交的 UUID
      expect(rec.body.toString()).toBe("{}");
      expect(rec.headers["x-api-resource-id"]).toBe("volc.seedasr.auc");
      if (query === 1) return { status: 200, headers: { "X-Api-Status-Code": "20000001" }, body: "" };
      return { status: 200, headers: { "X-Api-Status-Code": "20000000" }, body: volcSuccess([{ start: 1000, end: 2000, text: "整段" }], 30_000) };
    });
    const dir = freshDir();
    const { err, run } = await runStandard(dir, url, `${url}/audio.mp3`, 1, 30_000);
    expect(err).toBeUndefined();
    expect(submit).toBe(1);
    expect(query).toBe(2);
    expect(run?.engine).toBe("volcengine");
    expect(run?.modelId).toBe("volc.seedasr.auc");
    expect(run?.chunks).toEqual([{ index: 1, start: 0, end: 30 }]);
    expect(run?.transcript.utterances).toEqual([{ start: 1, end: 2, speakerId: "speaker-1" as SpeakerId, text: "整段" }]);
    const submitRec = calls.find((c) => c.url.includes("/submit"));
    const submitBody = JSON.parse(submitRec?.body.toString("utf8") ?? "{}") as Record<string, unknown>;
    expect((submitBody.user as Record<string, unknown>)?.uid).toBe("video-notes");
    expect((submitBody.audio as Record<string, unknown>)?.url).toBe(`${url}/audio.mp3`);
    expect(calls.length).toBe(3);
  });

  test("utterance 的 text 保留：响应带文本的段落在结果中保留该文本", async () => {
    freshEnv();
    const { url } = startVolcMock((rec) => {
      if (rec.url.includes("/submit")) return { status: 200, headers: { "X-Api-Status-Code": "20000000" }, body: "" };
      return { status: 200, headers: { "X-Api-Status-Code": "20000000" }, body: volcSuccess([{ start: 1000, end: 2000, text: "你好世界" }], 30_000) };
    });
    const dir = freshDir();
    const { err, run } = await runStandard(dir, url, `${url}/audio.mp3`, 1, 30_000);
    expect(err).toBeUndefined();
    expect(run?.transcript.utterances).toEqual([{ start: 1, end: 2, speakerId: "speaker-1" as SpeakerId, text: "你好世界" }]);
  });

  test("提交鉴权失败 401：不重试，只发一次请求", async () => {
    freshEnv();
    let submit = 0;
    const { url } = startVolcMock((rec) => {
      if (rec.url.includes("/submit")) submit += 1;
      return { status: 401, body: JSON.stringify({ message: `bad key ${API_KEY}` }) };
    });
    const dir = freshDir();
    const { err } = await runStandard(dir, url, `${url}/audio.mp3`, 1, 30_000);
    expect(submit).toBe(1);
    expect(err?.message).toContain("401");
    expect(err?.message).not.toContain(API_KEY);
    expect(err?.message).toContain("[redacted]");
  });

  test("查询 550：轮询内重试一次后成功", async () => {
    freshEnv();
    let query = 0;
    let polls = 0;
    const { url } = startVolcMock((rec) => {
      if (rec.url.includes("/submit")) return { status: 200, headers: { "X-Api-Status-Code": "20000000" }, body: "" };
      query += 1;
      if (query === 1) return { status: 200, headers: { "X-Api-Status-Code": "55000031" }, body: "{}" };
      return { status: 200, headers: { "X-Api-Status-Code": "20000000" }, body: volcSuccess([{ start: 1000, end: 2000, text: "ok" }], 30_000) };
    });
    const dir = freshDir();
    const engine = createUrlEngine(
      createVolcengineStandardProvider(
        { kind: "apiKey", apiKey: API_KEY },
        { submitUrl: `${url}/submit`, queryUrl: `${url}/query`, pollIntervalMs: 1, maxTotalMs: 60_000 },
      ),
      { fetchImpl: mockFetch(url) },
    );
    const video: Video = { id: "vid-volc" as Video["id"], title: "t", sourcePath: "", durationSeconds: 10, outputDir: dir };
    const progress: Progress[] = [];
    const run = await engine.run({
      video,
      wavPath: "",
      cacheDir: dir,
      sourceUrl: `${url}/audio.mp3`,
      onProgress: (p) => {
        if (p.detail?.includes("轮询")) polls += 1;
        progress.push(p);
      },
    });
    expect(query).toBe(2);
    expect(run.transcript.utterances).toEqual([{ start: 1, end: 2, speakerId: "speaker-1" as SpeakerId, text: "ok" }]);
    void polls;
  });

  test("轮询超过上限（注入 120ms）：报超时并停止", async () => {
    freshEnv();
    let query = 0;
    const { url } = startVolcMock((rec) => {
      if (rec.url.includes("/submit")) return { status: 200, headers: { "X-Api-Status-Code": "20000000" }, body: "" };
      query += 1;
      return { status: 200, headers: { "X-Api-Status-Code": "20000001" }, body: "" };
    });
    const dir = freshDir();
    const { err } = await runStandard(dir, url, `${url}/audio.mp3`, 40, 120);
    expect(err?.message).toContain("火山标准版转写超时");
    expect(query).toBeLessThanOrEqual(4);
  });

  test("缺 sourceUrl：立即报明确错误，零请求", async () => {
    freshEnv();
    const { url, calls } = startVolcMock(() => ({ status: 200, body: "{}" }));
    const dir = freshDir();
    const { err } = await runStandard(dir, url, undefined, 1, 30_000);
    expect(calls.length).toBe(0);
    expect(err?.message).toBe("火山标准版只接受公网 URL；本地视频请改用极速版或本地 ASR");
    void url;
  });

  test("同一 URL 两次运行：各自重新提交（不做 URL 内容缓存），结果一致", async () => {
    freshEnv();
    let submit = 0;
    const { url } = startVolcMock((rec) => {
      if (rec.url.includes("/submit")) {
        submit += 1;
        return { status: 200, headers: { "X-Api-Status-Code": "20000000" }, body: "" };
      }
      return { status: 200, headers: { "X-Api-Status-Code": "20000000" }, body: volcSuccess([{ start: 1000, end: 2000, text: "整段" }], 30_000) };
    });
    const dir = freshDir();
    const first = await runStandard(dir, url, `${url}/audio.mp3`, 1, 30_000);
    const second = await runStandard(dir, url, `${url}/audio.mp3`, 1, 30_000);
    expect(submit).toBe(2);
    expect(first.run?.transcript.utterances).toEqual(second.run?.transcript.utterances);
    expect(first.err).toBeUndefined();
    expect(second.err).toBeUndefined();
  });

  test("duration 缺失/非法：结构错误", async () => {
    freshEnv();
    let n = 0;
    const { url } = startVolcMock((rec) => {
      if (rec.url.includes("/submit")) return { status: 200, headers: { "X-Api-Status-Code": "20000000" }, body: "" };
      n += 1;
      if (n === 1) return { status: 200, headers: { "X-Api-Status-Code": "20000000" }, body: JSON.stringify({ audio_info: {}, result: { text: "", utterances: [] } }) };
      return { status: 200, headers: { "X-Api-Status-Code": "20000000" }, body: JSON.stringify({ audio_info: { duration: -5 }, result: { text: "", utterances: [] } }) };
    });
    const dir = freshDir();
    const a = await runStandard(dir, url, `${url}/a.mp3`, 1, 30_000);
    const b = await runStandard(dir, url, `${url}/b.mp3`, 1, 30_000);
    expect(a.err?.message).toContain("audio_info.duration");
    expect(b.err?.message).toContain("audio_info.duration");
  });
});
