import { afterAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAsrEngine } from "./engine";
import type { AsrRun } from "./engine";
import type { Progress } from "../core/steps";
import type { SpeakerId, Video } from "../core/types";

const SR = 16000;
const TEST_KEY = "sk-test-key-123";
const TEST_MODEL = "whisper-mock";

const servers: Server<undefined>[] = [];

afterAll(() => {
  for (const s of servers) s.stop(true);
});

/** 每个测试自建临时目录（ADR-0015 约定），不依赖 process.env 顺序。 */
function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "vnote-remote-"));
}

/**
 * 写 0.2Hz 正弦 wav（16k 单声道 16-bit PCM）：周期恰为 5 秒，
 * 硬切块 1 与块 2 的 PCM 完全相同；幅值始终远离静音阈值，silencedetect 不产生停顿。
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

type Part = { name: string; filename?: string; value?: string; bytes?: Buffer };
type Recorded = { url: string; headers: Record<string, string>; parts: Part[] };

function parseMultipart(body: Buffer, contentType: string): Part[] {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (match === null) return [];
  const boundary = `--${match[1] ?? match[2]}`;
  const text = body.toString("latin1");
  const parts: Part[] = [];
  let pos = text.indexOf(boundary);
  while (pos >= 0) {
    const next = text.indexOf(boundary, pos + boundary.length);
    if (next < 0) break;
    const section = text.slice(pos + boundary.length, next);
    const name = /name="([^"]*)"/.exec(section)?.[1];
    if (name !== undefined) {
      const headerEnd = section.indexOf("\r\n\r\n");
      const rawValue = headerEnd >= 0 ? section.slice(headerEnd + 4) : "";
      const value = rawValue.endsWith("\r\n") ? rawValue.slice(0, -2) : rawValue.replace(/\r$/, "");
      parts.push({ name, filename: /filename="([^"]*)"/.exec(section)?.[1], value, bytes: Buffer.from(value, "latin1") });
    }
    pos = next;
  }
  return parts;
}

function startMock(handler: (rec: Recorded) => { status: number; body: string }): { url: string; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => headers[k] = v);
      const body = Buffer.from(await req.arrayBuffer());
      const rec: Recorded = { url: req.url, headers, parts: parseMultipart(body, headers["content-type"] ?? "") };
      calls.push(rec);
      const { status, body: respBody } = handler(rec);
      return new Response(respBody, { status, headers: { "content-type": "application/json" } });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/v1`, calls };
}

function filePart(rec: Recorded): Part | undefined {
  return rec.parts.find((p) => p.name === "file");
}

function segmentsFor(filename: string): unknown {
  switch (filename) {
    case "chunk-1.mp3":
      return { segments: [{ start: 1, end: 2, text: "hello" }] };
    case "chunk-2.mp3":
      return { segments: [{ start: 1, end: 2, text: "hello" }] };
    case "chunk-3.mp3":
      return { segments: [{ start: 0.5, end: 1, text: "bye" }] };
    default:
      return { segments: [] };
  }
}

function bodyFor(rec: Recorded): unknown {
  const file = filePart(rec);
  return file?.filename !== undefined ? segmentsFor(file.filename) : { segments: [] };
}

const SMALL_LIMITS = { target: 4, min: 3, max: 5, hardMax: true };
const ONE_CHUNK_LIMITS = { target: 8, min: 6, max: 10, hardMax: true };

/** 正弦 wav + 注入小分块限额跑一次远程引擎；encodeChunk 用桩（不依赖真实 ffmpeg 转码）。 */
async function runRemote(
  url: string,
  dir: string,
  seconds: number,
  limits: { target: number; min: number; max: number; hardMax: boolean },
): Promise<{ run: AsrRun; progress: Progress[] }> {
  const wavPath = `${dir}/in.wav`;
  writeSineWav(wavPath, seconds);
  const engine = createAsrEngine(
    { provider: "remote", baseUrl: url, model: TEST_MODEL, apiKey: TEST_KEY },
    {
      chunkLimits: limits,
      fetchImpl: fetch,
      encodeChunk: async (_wav, out) => writeFileSync(out, Buffer.from([1, 2, 3])),
    },
  );
  const progress: Progress[] = [];
  const video: Video = {
    id: "vid-test" as Video["id"],
    title: "t",
    sourcePath: wavPath,
    durationSeconds: seconds,
    outputDir: dir,
  };
  const run = await engine.run({ video, wavPath, cacheDir: dir, onProgress: (p) => progress.push(p) });
  return { run, progress };
}

describe("远程 ASR 引擎", () => {
  test("请求契约：Bearer 鉴权、路径、multipart 字段与文件", async () => {
    const { url, calls } = startMock(() => ({ status: 200, body: JSON.stringify({ segments: [{ start: 1, end: 2, text: "hi" }] }) }));
    const dir = freshDir();
    await runRemote(url, dir, 5, ONE_CHUNK_LIMITS);
    expect(calls.length).toBe(1);
    const call = calls[0];
    if (call === undefined) throw new Error("没有收到请求");
    expect(call.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(call.url).toContain("/v1/audio/transcriptions");
    const fields: Record<string, string | undefined> = {};
    for (const p of call.parts) if (p.name !== "file") fields[p.name] = p.value;
    expect(fields.model).toBe(TEST_MODEL);
    expect(fields.response_format).toBe("verbose_json");
    expect(fields.temperature).toBe("0");
    expect(fields.language).toBe("zh");
    const file = filePart(call);
    expect(file?.filename).toBe("chunk-1.mp3");
    expect(file?.bytes?.length).toBe(3);
    expect(call.url).not.toContain(TEST_KEY);
  });

  test("逐块时间偏移：多块（注入小限额）按块起点平移，边界两侧相同短句都保留", async () => {
    const { url, calls } = startMock((rec) => ({ status: 200, body: JSON.stringify(bodyFor(rec)) }));
    const dir = freshDir();
    const { run, progress } = await runRemote(url, dir, 12, SMALL_LIMITS);
    // 12 秒、硬切限额 5：块 [0,5] [5,10] [10,12]。
    expect(run.chunks.map((c) => [c.start, c.end])).toEqual([[0, 5], [5, 10], [10, 12]]);
    // 块2 与块1 PCM 相同走缓存（只收到块1与块3两次请求），但时间按块2起点平移。
    expect(calls.length).toBe(2);
    expect(run.transcript.utterances).toEqual([
      { start: 1, end: 2, speakerId: "speaker-1" as SpeakerId, text: "hello" },
      { start: 6, end: 7, speakerId: "speaker-1" as SpeakerId, text: "hello" },
      { start: 10.5, end: 11, speakerId: "speaker-1" as SpeakerId, text: "bye" },
    ]);
    // 边界两侧相同短句「hello」两条都保留（不按文本去重）。
    expect(run.transcript.utterances.filter((x) => x.text === "hello").length).toBe(2);
    expect(run.transcript.speakers).toEqual([{ id: "speaker-1" as SpeakerId, name: "说话人1", color: "#6aa9ff" }]);
    expect(run.engine).toBe("remote");
    expect(run.modelId).toBe(TEST_MODEL);
    // 进度按块推进。
    expect(progress.length).toBe(3);
    expect(progress[2]?.step).toBe("transcribe");
    expect(progress[2]?.total).toBe(3);
  });

  test("相同 PCM 不同起点：缓存命中且按块起点加偏移，第二次运行全部走缓存", async () => {
    const { url, calls } = startMock((rec) => ({ status: 200, body: JSON.stringify(bodyFor(rec)) }));
    const dir = freshDir();
    const first = await runRemote(url, dir, 12, SMALL_LIMITS);
    // 块1 与块2 PCM 相同（0.2Hz 正弦周期恰 5 秒）：首次运行块2 就命中块1 的缓存（键只含 PCM），
    // 相对时间读出后加块2 起点，hello 平移为 6–7 秒；同一运行内也只发了块1、块3 两次请求。
    expect(first.run.cacheHits).toEqual(["chunk-2"]);
    const second = await runRemote(url, dir, 12, SMALL_LIMITS);
    expect(calls.length).toBe(2);
    expect(second.run.cacheHits).toEqual(["chunk-1", "chunk-2", "chunk-3"]);
    // 缓存只存块内相对时间，读后加块起点：块2 的 hello 仍在 6–7 秒。
    expect(second.run.transcript.utterances).toEqual(first.run.transcript.utterances);
    expect(second.run.transcript.utterances[1]?.start).toBe(6);
  });

  test("5xx 重试：500 后 200 成功，共 2 次请求", async () => {
    let n = 0;
    const { url, calls } = startMock(() => {
      n += 1;
      return n === 1
        ? { status: 500, body: "boom" }
        : { status: 200, body: JSON.stringify({ segments: [{ start: 1, end: 2, text: "ok" }] }) };
    });
    const dir = freshDir();
    const { run } = await runRemote(url, dir, 8, ONE_CHUNK_LIMITS);
    expect(calls.length).toBe(2);
    expect(run.transcript.utterances).toEqual([{ start: 1, end: 2, speakerId: "speaker-1" as SpeakerId, text: "ok" }]);
  });

  test("401 不重试且错误里不出现 key", async () => {
    const { url, calls } = startMock(() => ({ status: 401, body: JSON.stringify({ error: `invalid key ${TEST_KEY}` }) }));
    const dir = freshDir();
    const wavPath = `${dir}/in.wav`;
    writeSineWav(wavPath, 8);
    const engine = createAsrEngine(
      { provider: "remote", baseUrl: url, model: TEST_MODEL, apiKey: TEST_KEY },
      { chunkLimits: ONE_CHUNK_LIMITS, fetchImpl: fetch, encodeChunk: async (_w, o) => writeFileSync(o, Buffer.from([1])) },
    );
    let err: Error | undefined;
    try {
      const video: Video = {
        id: "vid-test" as Video["id"],
        title: "t",
        sourcePath: wavPath,
        durationSeconds: 8,
        outputDir: dir,
      };
      await engine.run({ video, wavPath, cacheDir: dir });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(Error);
    expect(calls.length).toBe(1);
    expect(err?.message).toContain("401");
    expect(err?.message).not.toContain(TEST_KEY);
    expect(err?.message).toContain("[redacted]");
  });

  test("无 segments（text 非空）：报「不返回逐句时间戳」", async () => {
    const { url } = startMock(() => ({ status: 200, body: JSON.stringify({ text: "hello world" }) }));
    const dir = freshDir();
    const wavPath = `${dir}/in.wav`;
    writeSineWav(wavPath, 8);
    const engine = createAsrEngine(
      { provider: "remote", baseUrl: url, model: TEST_MODEL, apiKey: TEST_KEY },
      { chunkLimits: ONE_CHUNK_LIMITS, fetchImpl: fetch, encodeChunk: async (_w, o) => writeFileSync(o, Buffer.from([1])) },
    );
    let err: Error | undefined;
    try {
      const video: Video = {
        id: "vid-test" as Video["id"],
        title: "t",
        sourcePath: wavPath,
        durationSeconds: 8,
        outputDir: dir,
      };
      await engine.run({ video, wavPath, cacheDir: dir });
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toBe("该端点不返回逐句时间戳，不能用于字幕");
  });

  test("整块静音：text 空且 segments 空是合法空结果", async () => {
    const { url } = startMock(() => ({ status: 200, body: JSON.stringify({ text: "" }) }));
    const { run } = await runRemote(url, freshDir(), 8, ONE_CHUNK_LIMITS);
    expect(run.transcript.utterances).toEqual([]);
  });

  test("越界/倒序/乱序 segments：钳制到块范围、丢弃非法、按起点排序", async () => {
    const { url } = startMock(() => ({
      status: 200,
      body: JSON.stringify({
        segments: [
          { start: -2, end: 2, text: "a" },
          { start: 3, end: 999, text: "b" },
          { start: 5, end: 4, text: "c" },
          { start: 2, end: 3, text: "d" },
          { start: 1, end: 2, text: "" },
        ],
      }),
    }));
    const { run } = await runRemote(url, freshDir(), 8, ONE_CHUNK_LIMITS);
    // 块 [0,8]，上限 8.5：a 钳到 0–2；d 保留；b 钳到 3–8.5；倒序 c 丢弃；空文本丢弃。
    expect(run.transcript.utterances).toEqual([
      { start: 0, end: 2, speakerId: "speaker-1" as SpeakerId, text: "a" },
      { start: 2, end: 3, speakerId: "speaker-1" as SpeakerId, text: "d" },
      { start: 3, end: 8.5, speakerId: "speaker-1" as SpeakerId, text: "b" },
    ]);
  });
});
