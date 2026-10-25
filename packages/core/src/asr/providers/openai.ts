/**
 * OpenAI 兼容协议适配器（ADR-0015 §5 / ADR-0016 §6）：
 * `POST <baseUrl>/audio/transcriptions`，multipart 字段、`Authorization: Bearer`、`verbose_json`。
 * 单次请求 + 按 HTTP 状态分类成 `RemoteAsrError(retriable)`；重试节奏（最多 2 次、第 2 次前等 1 秒）
 * 由共享管线 `asr/remote.ts` 按 `RemoteAsrError.retriable` 驱动。
 * 429/5xx、超时、网络错误可重试；401/403 与其余状态不重试。错误文案保持 ADR-0015 原样。
 */
import { normalizeBaseUrl, sanitizeSegments, RemoteAsrError } from "../remote";
import type { RemoteChunkAudio, RemoteProvider, RemoteTranscribeResult } from "../remote";
import { redact } from "../../llm/openai";
import { logger } from "../../core/logger";

const SINGLE_TIMEOUT_MS = 60_000;


/** 原始 OpenAI 响应的未规整形状（`text`/`segments` 由本适配器用共享 sanitizeSegments 规整）。 */
type OpenAiRaw = { text?: unknown; segments?: unknown };

export function createOpenAiProvider({ baseUrl, model, apiKey }: { baseUrl: string; model: string; apiKey: string }): RemoteProvider {
  const normalized = normalizeBaseUrl(baseUrl);
  const url = `${normalized}/audio/transcriptions`;
  return {
    id: "openai",
    modelId: model,
    adapterVersion: 1,
    cache: { baseUrl: normalized, responseFormat: "verbose_json", model },
    audio: "mp3",
    timeoutMs: SINGLE_TIMEOUT_MS,
    async transcribe(chunk: RemoteChunkAudio, fetchImpl: typeof fetch): Promise<RemoteTranscribeResult> {
      const log = logger();
      const startedAt = Date.now();
      let status = 0;
      try {
        const form = new FormData();
        form.append("file", new Blob([Buffer.from(chunk.bytes)], { type: "audio/mpeg" }), chunk.fileName);
        form.append("model", model);
        form.append("response_format", "verbose_json");
        form.append("temperature", "0");
        form.append("language", "zh");
        // 超时/网络错误（AbortSignal.timeout 的 TimeoutError、undici 的 TypeError）由共享管线
        // 统一转成可重试的 RemoteAsrError；这里只处理 HTTP 状态与非 JSON 响应。
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}` },
          body: form,
          signal: AbortSignal.timeout(SINGLE_TIMEOUT_MS),
        });
        const bodyText = await res.text();
        // 每个请求一行 info：HTTP 状态、耗时、音频字节数；不记录音频载荷
        log.info("asr", "远程 ASR 请求", { provider: "openai", status: res.status, durationMs: Date.now() - startedAt, bytes: chunk.bytes.byteLength });
        status = res.status;
        if (res.ok) {
          let parsed: OpenAiRaw;
          try {
            parsed = JSON.parse(bodyText) as OpenAiRaw;
          } catch {
            throw new Error(`远程 ASR 返回了非 JSON 响应：${redact(bodyText.slice(0, 300), apiKey)}`);
          }
          const segments = sanitizeSegments(parsed.segments, chunk.duration);
          if (segments.length === 0 && typeof parsed.text === "string" && parsed.text.trim() !== "") {
            throw new Error("该端点不返回逐句时间戳，不能用于字幕");
          }
          return { segments, rawText: parsed.text };
        }
        // 429/5xx 才重试；401/403/413 与其余状态直接抛出。
        throw new RemoteAsrError(
          `远程 ASR 返回 HTTP ${res.status}：${redact(bodyText.slice(-300), apiKey)}`,
          res.status === 429 || res.status >= 500,
        );
      } catch (err) {
        // 非 2xx 状态也会走这里：error 行带脱敏后的错误文案、状态码、响应体片段与完整 stack
        const message = redact(err instanceof Error ? err.message : String(err), apiKey);
        const excerpt = message.includes("：") ? message.slice(message.lastIndexOf("：") + 1).slice(0, 300) : "";
        log.error("asr", "远程 ASR 失败", { provider: "openai", status, durationMs: Date.now() - startedAt, bytes: chunk.bytes.byteLength, error: message, bodyExcerpt: excerpt === "" ? undefined : excerpt, stack: err instanceof Error ? err.stack : undefined });
        throw err;
      }
    },
  };
}
