import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmClient, LlmEndpoint } from "../core/steps";
import { runExtract } from "./extract";

const endpoint: LlmEndpoint = { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "test-model" };

function mkdtemp(): string {
  const dir = join(tmpdir(), "vnote-extract-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 用 ffmpeg 生成一段 2 秒的彩色条视频 + 静音音频（probe 与抽音都走真 ffmpeg）。 */
function makeMp4(path: string): void {
  execFileSync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", "color=c=red:s=128x80:d=2", "-f", "lavfi", "-i", "sine=d=2", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path],
    { stdio: "pipe" },
  );
}

/** 假 LLM：主题划分与要点都直接给固定答案（extract 失败测试不会走到这里）。 */
function fakeClient(): LlmClient {
  return {
    model: endpoint.model,
    chat: async (_m, opts) => {
      if (!opts?.json) throw new Error("需要 json");
      return JSON.stringify({
        topics: [{ title: "foo", summary: "s", segments: [{ start: 0, end: 2 }] }],
        keyPoints: ["要点"],
      });
    },
  };
}

/**
 * extract 无法注入 probe/ASR（`runExtract` 直接调 `probeVideo` 与 `createAsrEngine`），
 * 故用真 mp4 + 指向不存在模型目录的本地 ASR 触发失败：失败点在 `engine.run`（onPrepared 之后、
 * 写任何主题之前），可断言 token 写盘与 onPrepared 顺序。
 */
describe("runExtract 的 onPrepared 顺序与中断结算", () => {
  test("token 取锁后、写主题前落盘；onPrepared 在抽音前触发；失败结算后 token 清 null", async () => {
    const dir = mkdtemp();
    const videoPath = join(dir, "in.mp4");
    makeMp4(videoPath);
    const cacheRoot = join(dir, ".cache");

    const seen: Array<{ videoId: string; outputDir: string; runToken: string }> = [];
    let marker = "";
    const r = await
      runExtract({
        videoPath,
        notesRoot: join(dir, "notes"),
        endpoint,
        cacheRoot,
        client: fakeClient(),
        asr: { provider: "local", modelDir: join(dir, "no-such-model") },
        runToken: "tok-extract",
        onPrepared: async (info) => {
          seen.push(info);
          // 在 onPrepared 时刻读磁盘：token 已落盘、还没有任何主题
          marker = readFileSync(join(info.outputDir, "video.json"), "utf8");
        },
      })
    .catch((e) => e);
    // 失败（本地 ASR 模型缺失）
    expect(r).toBeInstanceOf(Error);
    expect(String((r as Error).message)).toContain("模型加载失败");

    // onPrepared 只触发一次，且带 token
    expect(seen).toHaveLength(1);
    expect(seen[0]?.runToken).toBe("tok-extract");
    expect(seen[0]?.videoId).not.toBe("");

    // onPrepared 时刻：token 已写盘、主题为空（写主题在抽音之后）
    const atPrepared = JSON.parse(marker) as { runToken: string | null; topics: unknown[] };
    expect(atPrepared.runToken).toBe("tok-extract");
    expect(atPrepared.topics).toEqual([]);

    // 失败结算后：token 清 null，锁释放
    const final = JSON.parse(readFileSync(join(seen[0]!.outputDir, "video.json"), "utf8")) as { runToken: string | null };
    expect(final.runToken).toBeNull();
    expect(existsSync(join(seen[0]!.outputDir, ".vnote-run.lock"))).toBe(false);
  });
});
