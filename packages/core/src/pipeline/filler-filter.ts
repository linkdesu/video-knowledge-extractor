/**
 * 语义空洞短句过滤（r76 / #109）：规则判定 + 模型整批判定，合并成一处。
 *
 * 两段判定，顺序固定：
 * 1. 规则（`asr/short-replies.ts` 的 `SHORT_REPLY_RULES`）：时长/字数双闸门 + 语气词/回应语/半截话；
 * 2. 模型：规则放过、但仍然是短句的行按批交给模型，一次请求一整批带编号的短句，只回要丢弃的编号。
 *    「OKKAYK。」「哈LL喽你好。」「嗯，喂，你好。」这类规则表写不全的噪声靠这一步。
 *
 * 为什么在 pipeline 这一层合并而不是在 ASR 引擎里：转写行会被落盘进 `video.json`，
 * 之后的划主题、生成笔记、重渲染都读它；只有在落盘前统一跑一次，远程 ASR 与模型判定才都覆盖到，
 * 也才不会有第二套重复实现。规则阶段留在同一函数里，调用方只认 `filterFillerUtterances` 一个入口。
 *
 * 失败姿态（#109 验收 4）：模型不可用、超时、回复不合格式都只影响该批——该批原样保留并记日志，
 * 绝不因为一次判失败就丢行，也绝不打断导入。
 */
import { filterShortReplies, normalizeReplyText } from "../asr/short-replies";
import { logger } from "../core/logger";
import { promptFingerprint, renderPrompt } from "../core/prompts";
import type { PromptOverrides } from "../core/prompts";
import type { LlmClient, LlmEndpoint } from "../core/steps";
import { createLlmClient, tryParseJson } from "../llm/openai";

/** 一次请求带的句子条数：太少浪费往返，太多模型容易看漏编号。 */
export const FILLER_BATCH_SIZE = 40;

/**
 * 交给模型的候选行上界：仍然是「短句」才值得判语义空洞。
 * 更长的行多半有内容，直接保留、不进请求（也顺带压住提示词体积）。
 *
 * 8 秒 / 24 字太宽（r76b QA 用真实模型在真实录音上误删 16 条，其中 9 条正是这个宽度放进来的：
 * 4:05–4:37 的四行火腿对话 17–24 字、5.7 秒的「关蓝牙」说明、3 秒级的表态句）。收到 2.5 秒 / 12 字：
 * - 上界只留真正「一句短话」，#109 要删的三行噪声（1.40s/7 字、0.98s/4 字、2.46s/9 字）都还在里面；
 * - 现场确认的极短句（「听懂了吗？」3 字 0.46 秒）仍然进请求，靠提示词保留——闸门只挡长度，不替模型判内容。
 */
export const FILLER_CANDIDATE_MAX_SECONDS = 2.5;
export const FILLER_CANDIDATE_MAX_CHARS = 12;

/** 日志里每条丢弃文本的截断长度，避免一整行日志被长句撑爆。 */
const LOG_TEXT_CHARS = 40;

/** 模型点掉的一条：批内 1-based 序号 + 可选的短理由。 */
type DropDecision = { index: number; reason?: string };

/** 一批的判定结果：既是返回值，也是日志与验收台可回看的证据。 */
export type FillerBatchLog = {
  /** 批次序号，从 1 开始。 */
  batch: number;
  /** 本批送给模型的句子条数。 */
  size: number;
  /** 本批句子在入参 `rows` 里的 1-based 行号（整批）。 */
  sent: number[];
  /** 被丢弃的行在入参 `rows` 里的 1-based 行号。 */
  rows: number[];
  /** 被丢弃的批内序号（1-based）。 */
  drop: number[];
  /** 被丢弃的行文本（截断）。 */
  texts: string[];
  /** 模型给的理由（可能为空串）。 */
  reasons: string[];
  /** 本批失败的原因：失败时该批全部保留。 */
  error?: string;
};

export type FillerFilterResult<T> = {
  rows: T[];
  /** 规则阶段丢掉的行数。 */
  droppedByRules: number;
  /** 模型阶段丢掉的行数。 */
  droppedByLlm: number;
  batches: FillerBatchLog[];
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 解析模型回复里的 `drop`：接受 `[number]` 与 `[{index,reason}]` 两种形状。
 * 形状本身不对（不是对象 / 没有 drop 数组）抛错，让调用方按「该批不过滤」处理；
 * 单条不合法（越界、重复、非整数）只是忽略该条——只保留编号可信的那部分判定。
 */
function parseDropDecisions(text: string, size: number): DropDecision[] {
  const raw = tryParseJson<{ drop?: unknown }>(text);
  if (raw === null || typeof raw !== "object" || !Array.isArray(raw.drop)) {
    throw new Error(`模型回复格式不合法（缺少 drop 数组）：${text.slice(0, 120)}`);
  }
  const seen = new Set<number>();
  const out: DropDecision[] = [];
  for (const item of raw.drop) {
    let index: unknown = item;
    let reason: unknown;
    if (typeof item === "object" && item !== null) {
      index = "index" in item ? item.index : undefined;
      reason = "reason" in item ? item.reason : undefined;
    }
    const n = typeof index === "string" && /^\d+$/.test(index.trim()) ? Number(index.trim()) : index;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > size || seen.has(n)) continue;
    seen.add(n);
    out.push(typeof reason === "string" && reason.trim() !== "" ? { index: n, reason: truncate(reason, LOG_TEXT_CHARS) } : { index: n });
  }
  return out;
}

/**
 * 转写落盘前的统一过滤：先规则、后模型批量判定。
 * 模型任何失败都只记日志并保留该批，返回值里 `batches` 记录了每批的大小、丢弃序号与理由。
 */
export async function filterFillerUtterances<T extends { start: number; end: number; text: string }>(input: {
  rows: readonly T[];
  endpoint: LlmEndpoint;
  client?: LlmClient;
  prompts?: PromptOverrides;
}): Promise<FillerFilterResult<T>> {
  const log = logger();
  const kept = filterShortReplies(input.rows);
  const droppedByRules = input.rows.length - kept.length;
  // 候选：规则没删掉、且仍然够短（归一化字数与时长双闸门）；更长的行多半有内容，不进请求。
  const candidates = kept
    .map((row, position) => ({ row, position }))
    .filter(({ row }) => row.end - row.start <= FILLER_CANDIDATE_MAX_SECONDS && normalizeReplyText(row.text).length <= FILLER_CANDIDATE_MAX_CHARS);

  const finish = (rows: T[], droppedByLlm: number, batches: FillerBatchLog[]): FillerFilterResult<T> => {
    log.info("asr", "填充语过滤完成", {
      rowsIn: input.rows.length,
      rowsOut: rows.length,
      droppedByRules,
      droppedByLlm,
      candidates: candidates.length,
      batches: batches.length,
      failedBatches: batches.filter((b) => b.error !== undefined).length,
    });
    return { rows, droppedByRules, droppedByLlm, batches };
  };

  if (candidates.length === 0) return finish(kept, 0, []);

  let client: LlmClient;
  try {
    client = input.client ?? createLlmClient(input.endpoint);
  } catch (err) {
    log.warn("llm", "填充语过滤跳过", { candidates: candidates.length, error: errorText(err) });
    return finish(kept, 0, []);
  }

  const batches: FillerBatchLog[] = [];
  /** 被模型点掉的行：`kept` 里的下标。 */
  const dropped = new Set<number>();

  for (let offset = 0, batch = 1; offset < candidates.length; offset += FILLER_BATCH_SIZE, batch += 1) {
    const slice = candidates.slice(offset, offset + FILLER_BATCH_SIZE);
    const sent = slice.map(({ position }) => position + 1);
    const list = slice.map(({ row }, i) => `${i + 1}. ${row.text.trim()}`).join("\n");
    try {
      const rendered = renderPrompt("filler-filter", { SENTENCES: list }, input.prompts);
      const fingerprint = promptFingerprint("filler-filter", rendered, input.prompts);
      log.info("llm", "提示词版本", {
        promptId: fingerprint.id,
        promptSource: fingerprint.source,
        promptSha256: fingerprint.sha256,
        model: client.model,
        kind: "filler-filter",
      });
      const text = await client.chat(
        [
          { role: "system", content: rendered },
          { role: "user", content: '只输出 JSON：{"drop":[number]}，编号必须来自上面的列表。' },
        ],
        { json: true, temperature: 0 },
      );
      const decisions = parseDropDecisions(text, slice.length);
      for (const decision of decisions) {
        const picked = slice[decision.index - 1];
        if (picked === undefined) continue;
        dropped.add(picked.position);
      }
      const entry: FillerBatchLog = {
        batch,
        size: slice.length,
        sent,
        rows: decisions.map((d) => sent[d.index - 1] ?? 0),
        drop: decisions.map((d) => d.index),
        texts: decisions.map((d) => truncate(slice[d.index - 1]?.row.text ?? "", LOG_TEXT_CHARS)),
        reasons: decisions.map((d) => d.reason ?? ""),
      };
      log.info("llm", "填充语过滤批次", {
        batch: entry.batch,
        batchSize: entry.size,
        sent: entry.sent,
        drop: entry.drop,
        rows: entry.rows,
        texts: entry.texts,
        reasons: entry.reasons,
        model: client.model,
      });
      batches.push(entry);
    } catch (err) {
      const reason = errorText(err);
      log.warn("llm", "填充语过滤跳过本批", { batch, batchSize: slice.length, sent, error: reason });
      batches.push({ batch, size: slice.length, sent, rows: [], drop: [], texts: [], reasons: [], error: reason });
    }
  }

  const rows = kept.filter((_row, position) => !dropped.has(position));
  return finish(rows, dropped.size, batches);
}
