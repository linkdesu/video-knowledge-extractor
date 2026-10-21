/**
 * 缓存键：步骤名 + 真实输入指纹，落盘为文件（ADR-0006）。
 *
 * 每一步必须把真实输入全部放进 inputs，漏一项就是“改了没生效”的假命中：
 *
 * | 步骤               | 必含输入                                                        |
 * | ------------------ | --------------------------------------------------------------- |
 * | transcribe         | 分块音频哈希、识别/分离/标点模型、单段上限                       |
 * | correct            | 转写键、纠错词表内容                                             |
 * | topic-candidates   | 分块纠错后字幕键、提示词版本、端点模型名                         |
 * | note               | 主题（标题/摘要/时间段）、该主题的纠错后字幕、提示词版本、端点模型名、词表内容 |
 */

export type CacheStep = "transcribe" | "correct" | "topic-candidates" | "note";

declare const cacheBrand: unique symbol;

/** 只能由 `cacheKey()` 生产，避免把任意字符串当键用。 */
export type CacheKey = {
  readonly step: CacheStep;
  readonly hash: string;
  readonly [cacheBrand]: true;
};

export type CacheInputs = Record<string, string | number | boolean>;

export function sha256(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** 键序无关的 JSON 指纹，用于词表这类结构化输入。 */
export function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value, stableKeys));
}

function stableKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value).sort()) sorted[k] = (value as Record<string, unknown>)[k];
  return sorted;
}

export function cacheKey(step: CacheStep, inputs: CacheInputs): CacheKey {
  const canonical = Object.keys(inputs)
    .sort()
    .map((k) => [k, inputs[k]]);
  return { step, hash: sha256(JSON.stringify([step, canonical])) } as CacheKey;
}

/** 缓存文件路径：`<cacheDir>/<step>/<hash>.json`。 */
export function cachePath(cacheDir: string, key: CacheKey): string {
  return `${cacheDir}/${key.step}/${key.hash}.json`;
}
