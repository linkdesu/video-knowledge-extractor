#!/usr/bin/env bun
/**
 * 火山引擎 ASR 真实 smoke（ADR-0016 §10，手动运行，不进默认测试）：
 * 1. 对官方示例公网 URL 做一次标准版 submit/query（走 core provider）；
 * 2. 下载同一 mp3 后做一次极速版请求（走 core provider 的协议常量，裸发一次：
 *    provider 的 flash 音频格式固定 wav，mp3 直接发 audio.format "mp3"，
 *    字段名与限制已按 2026-10-22 官方文档核实）。
 * 总请求次数固定为两次转写加必要的查询轮询，不循环重试。
 * 不打印 key 与音频；未配 key 时记录原因并以 0 退出。
 * 失败时打印 HTTP 状态码、X-Api-Status-Code 与 X-Tt-Logid（不打印响应体与凭据）。
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { loadDotenvFiles } from "../../../packages/core/src/core/env";
import { asrEnv } from "../../../packages/core/src/core/config";
import {
  VOLCENGINE_FLASH_MODEL,
  VOLCENGINE_FLASH_RESOURCE_ID,
  VOLCENGINE_FLASH_URL,
} from "../../../packages/core/src/core/config";
import { createVolcengineStandardProvider } from "../../../packages/core/src/asr/providers/volcengine";
import type { VolcengineAuth } from "../../../packages/core/src/core/credentials";

const OFFICIAL_URL =
  "https://lf3-static.bytednsdoc.com/obj/eden-cn/lm_hz_ihsph/ljhwZthlaukjlkulzlp/console/bigtts/zh_female_cancan_mars_bigtts.mp3";

async function main(): Promise<void> {
  loadDotenvFiles({ cwd: process.cwd(), resolveRoot: () => process.cwd() });
  const env = asrEnv();
  let auth: VolcengineAuth | undefined;
  if (env.volcAuthMode === "appAccessKey") {
    if (env.volcAppKey !== undefined && env.volcAccessKey !== undefined) {
      auth = { kind: "appAccessKey", appKey: env.volcAppKey, accessKey: env.volcAccessKey };
    }
  } else if (env.volcApiKey !== undefined) {
    auth = { kind: "apiKey", apiKey: env.volcApiKey };
  }
  if (auth === undefined) {
    console.log("未找到火山 key（VNOTE_VOLC_API_KEY / VOLC_ASR_API_KEY，或 VNOTE_VOLC_APP_KEY + VNOTE_VOLC_ACCESS_KEY），跳过 smoke。");
    process.exit(0);
  }
  console.log(`鉴权方式: ${auth.kind}（不打印 key）`);

  function authHeaders(value: VolcengineAuth): Record<string, string> {
    return value.kind === "apiKey" ? { "X-Api-Key": value.apiKey } : { "X-Api-App-Key": value.appKey, "X-Api-Access-Key": value.accessKey };
  }

  // (a) 标准版：官方示例 URL，submit + 必要轮询（走 core provider）。
  const standard = createVolcengineStandardProvider(auth);
  const t0 = Date.now();
  let stdDuration: number;
  let stdSegments: { start: number; end: number; text: string }[];
  try {
    const result = await standard.transcribeUrl(OFFICIAL_URL, fetch, (attempt) => console.log(`标准版查询第 ${attempt} 次…`));
    stdDuration = result.duration;
    stdSegments = result.segments;
  } catch (err) {
    console.log(`标准版失败（未开通或鉴权失败）：${(err as Error).message}`);
    return;
  }
  console.log(`标准版完成：${((Date.now() - t0) / 1000).toFixed(1)}s，duration ${stdDuration.toFixed(1)}s，utterance ${stdSegments.length} 条`);
  if (stdSegments.length > 0) console.log(`首条起始 ${stdSegments[0]?.start.toFixed(1)}s：${stdSegments[0]?.text}`);

  // (b) 极速版：下载同一 mp3，裸发一次同步请求（mp3 是官方支持格式，provider 的
  // audio.format 固定 wav，因此这里直接按协议发，只发一次、不重试）。
  const audio = new Uint8Array(await (await fetch(OFFICIAL_URL)).arrayBuffer());
  const tempPath = `${tmpdir()}/vnote-smoke-${Date.now()}.mp3`;
  await writeFile(tempPath, audio);
  console.log(`已下载 ${audio.byteLength} 字节到临时文件（不打印内容）`);
  const t1 = Date.now();
  try {
    const uid = auth.kind === "appAccessKey" ? auth.appKey : "video-notes";
    const response = await fetch(VOLCENGINE_FLASH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Resource-Id": VOLCENGINE_FLASH_RESOURCE_ID,
        "X-Api-Request-Id": randomUUID(),
        "X-Api-Sequence": "-1",
        ...authHeaders(auth),
      },
      body: JSON.stringify({
        user: { uid },
        audio: { format: "mp3", data: Buffer.from(audio).toString("base64") },
        request: {
          model_name: VOLCENGINE_FLASH_MODEL,
          show_utterances: true,
          enable_itn: true,
          enable_punc: true,
          enable_speaker_info: false,
        },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const status = response.headers.get("X-Api-Status-Code") ?? "(缺失)";
    const logid = response.headers.get("X-Tt-Logid") ?? "(缺失)";
    console.log(`极速版：HTTP ${response.status}，X-Api-Status-Code ${status}，X-Tt-Logid ${logid}`);
    if (!response.ok) {
      console.log("极速版失败（未开通或鉴权失败，按 ADR §7.1 第 1 步分类处理，不重试）");
      return;
    }
    if (status === "20000000" || status === "20000003") {
      // 20000003 是静音音频：合法空结果。
      const body = (await response.json()) as {
        result?: { text?: unknown; utterances?: unknown };
      };
      const utterances = Array.isArray(body.result?.utterances)
        ? (body.result?.utterances as { start_time?: unknown; end_time?: unknown }[]).filter(
            (u) => typeof u?.start_time === "number" && typeof u?.end_time === "number",
          )
        : [];
      console.log(`极速版完成：${((Date.now() - t1) / 1000).toFixed(1)}s，utterance ${utterances.length} 条`);
      const first = utterances[0];
      if (first !== undefined) console.log(`首条起始 ${(first.start_time as number) / 1000}s（毫秒 ${first.start_time}）`);
    } else {
      console.log("极速版失败（业务码不是 20000000 / 20000003，不重试；未开通极速版时会落在这里）");
    }
  } catch (err) {
    console.log(`极速版失败：${(err as Error).message}`);
  } finally {
    if (existsSync(tempPath)) await unlink(tempPath);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`smoke 错误: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
