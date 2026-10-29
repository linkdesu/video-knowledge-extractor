import { cacheKey, hashJson, readCache, writeCache } from "../core/cache";
import { logger } from "../core/logger";
import { resolveSpeaker } from "../core/speaker-map";
import { renderPrompt } from "../core/prompts";
import type { PromptOverrides } from "../core/prompts";
import { createLlmClient, parseJsonLoose } from "../llm/openai";
import type { LlmClient, LlmEndpoint } from "../core/steps";
import type { SpeakerId, Transcript } from "../core/types";

/** 一个说话人在整条时间轴上的发言统计；`answer*` 只算「在回答问题」的那些发言轮。 */
export type SpeakerStat = {
  id: SpeakerId;
  name: string;
  seconds: number;
  turns: number;
  answerSeconds: number;
  answerTurns: number;
};

/** 主播识别的最小发言占比：低于这个比例的说话人不可能是主播。 */
const MIN_SHARE = 0.08;
/** 至少回答过这么多次问题才可能是主播（一次应答可能只是附和）。 */
const MIN_ANSWER_TURNS = 2;
/** 回答轮占自己发言轮的一半，或者回答时长占到全片 20%，才算「在回答别人」。 */
const MIN_ANSWER_TURN_RATIO = 0.5;
const MIN_ANSWER_TOTAL_SHARE = 0.2;
/** 和第一候选人的回答时长差太多就不再算主播（被提问者偶尔插话解释几句）。 */
const RELATIVE_ANSWER_SECONDS = 0.5;
/** 主播最多三个：再多就不是「主播」了。 */
const MAX_HOSTS = 3;
/** 每个说话人给模型看的示例发言条数。 */
const EXAMPLES_PER_SPEAKER = 6;
/** 示例发言截断长度，避免长段落撑爆提示词。 */
const EXAMPLE_MAX_CHARS = 80;

/** 问题标记：句末问号，或中文疑问/商量语气词（后面可再跟标点）。 */
const QUESTION_END_RE = /[？?]\s*$|[吗呢吧][？?。！!，,\s]*$/;

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * 逐说话人统计发言时长、轮数，以及「紧接着别人的提问之后的那一轮」。
 * 说话人合并（`mergedInto`）在统计里折叠到存活者：同一人被拆成两个 id 时算一个人。
 */
export function speakerStats(transcript: Transcript): SpeakerStat[] {
  const speakers = transcript.speakers;
  const stats = new Map<string, SpeakerStat>();
  for (const s of speakers) {
    if (s.mergedInto !== null && s.mergedInto !== undefined) continue;
    const resolved = resolveSpeaker(speakers, s.id);
    stats.set(resolved.id, { id: resolved.id as SpeakerId, name: resolved.name, seconds: 0, turns: 0, answerSeconds: 0, answerTurns: 0 });
  }
  let prev: { id: string; text: string } | undefined;
  for (const u of transcript.utterances) {
    const resolved = resolveSpeaker(speakers, u.speakerId);
    const stat = stats.get(resolved.id);
    if (stat !== undefined) {
      stat.seconds += Math.max(0, u.end - u.start);
      stat.turns += 1;
      if (prev !== undefined && prev.id !== resolved.id && QUESTION_END_RE.test(prev.text.trim())) {
        stat.answerSeconds += Math.max(0, u.end - u.start);
        stat.answerTurns += 1;
      }
    }
    prev = { id: resolved.id, text: u.text };
  }
  return [...stats.values()];
}

/**
 * 纯统计兜底：发言占比 ≥ 8%、回答轮 ≥ 2，且（回答轮 / 轮数 ≥ 0.5 或 回答时长 ≥ 全片 20%），
 * 再按回答时长筛掉不足第一名 50% 的人，最多留 3 个。按回答时长从多到少返回。
 * 只有一个说话人时没有「谁在回答别人」可言，说话的人就是主播。
 */
export function heuristicHosts(stats: SpeakerStat[], totalSeconds: number): SpeakerId[] {
  if (stats.length === 0) return [];
  const total = totalSeconds > 0 ? totalSeconds : stats.reduce((m, s) => Math.max(m, s.seconds), 0);
  if (total <= 0) return [];
  const only = stats.length === 1 ? stats[0] : undefined;
  if (only !== undefined && only.seconds > 0) return [only.id];
  const candidates = stats.filter((s) => {
    const share = s.seconds / total;
    if (share < MIN_SHARE) return false;
    if (s.answerTurns < MIN_ANSWER_TURNS) return false;
    const answerRatio = s.turns > 0 ? s.answerTurns / s.turns : 0;
    if (answerRatio < MIN_ANSWER_TURN_RATIO && s.answerSeconds / total < MIN_ANSWER_TOTAL_SHARE) return false;
    return true;
  });
  if (candidates.length === 0) return [];
  const topAnswerSeconds = Math.max(...candidates.map((s) => s.answerSeconds));
  const kept = candidates
    .filter((s) => s.answerSeconds >= topAnswerSeconds * RELATIVE_ANSWER_SECONDS)
    .sort((a, b) => b.answerSeconds - a.answerSeconds || b.turns - a.turns);
  return kept.slice(0, MAX_HOSTS).map((s) => s.id);
}

/** 模型看到的一行：名字、id、发言时长、轮数、回答轮数、占比。 */
function speakerLine(stat: SpeakerStat, totalSeconds: number, examples: string[]): string {
  const share = totalSeconds > 0 ? Math.round((stat.seconds / totalSeconds) * 100) : 0;
  const head = `${stat.name}（id=${stat.id}）发言 ${formatClock(stat.seconds)} / ${stat.turns} 轮，回答 ${stat.answerTurns} 轮 / ${formatClock(stat.answerSeconds)}，占比 ${share}%`;
  if (examples.length === 0) return head;
  return `${head}；示例发言：\n${examples.map((e) => `  - ${e}`).join("\n")}`;
}

/** 每个说话人的代表性发言：优先回答轮，不够再用最长的那几轮补齐。 */
function exampleLines(transcript: Transcript, speakerIds: ReadonlySet<string>): Map<string, string[]> {
  const speakers = transcript.speakers;
  const answers = new Map<string, string[]>();
  const longest = new Map<string, { len: number; text: string }[]>();
  let prev: { id: string; text: string } | undefined;
  for (const u of transcript.utterances) {
    const resolved = resolveSpeaker(speakers, u.speakerId);
    if (!speakerIds.has(resolved.id)) {
      prev = { id: resolved.id, text: u.text };
      continue;
    }
    const text = truncate(u.text, EXAMPLE_MAX_CHARS);
    const isAnswer = prev !== undefined && prev.id !== resolved.id && QUESTION_END_RE.test(prev.text.trim());
    if (isAnswer) {
      const list = answers.get(resolved.id) ?? [];
      list.push(text);
      answers.set(resolved.id, list);
    }
    const durList = longest.get(resolved.id) ?? [];
    durList.push({ len: u.end - u.start, text });
    durList.sort((a, b) => b.len - a.len);
    longest.set(resolved.id, durList.slice(0, EXAMPLES_PER_SPEAKER));
    prev = { id: resolved.id, text: u.text };
  }
  const out = new Map<string, string[]>();
  for (const id of speakerIds) {
    const picked = [...(answers.get(id) ?? [])];
    for (const item of longest.get(id) ?? []) {
      if (picked.length >= EXAMPLES_PER_SPEAKER) break;
      if (picked.includes(item.text)) continue;
      picked.push(item.text);
    }
    out.set(id, picked.slice(0, EXAMPLES_PER_SPEAKER));
  }
  return out;
}

type RawHostResponse = { hosts?: unknown };

/** 模型回复的两种形状：`["id"]` 或 `[{"id":"id"}]`；其它形状一律丢掉。 */
function hostIdsOf(raw: RawHostResponse): string[] {
  if (!Array.isArray(raw.hosts)) return [];
  const out: string[] = [];
  for (const item of raw.hosts) {
    if (typeof item === "string") out.push(item);
    else if (typeof item === "object" && item !== null && "id" in item && typeof item.id === "string") out.push(item.id);
  }
  return out;
}

export type DetectHostsResult = { hosts: SpeakerId[]; source: "auto" | "heuristic" | "none" };

/**
 * 识别主播：先用模型判，模型不可用/答非所问时退回纯统计，两条路都不成立就留空。
 * 任何失败都只记日志，不抛错——主播只是提示词里的补充信息，不能挡住导入。
 */
export async function detectHosts(input: {
  transcript: Transcript;
  endpoint: LlmEndpoint;
  cacheDir: string;
  client?: LlmClient;
  prompts?: PromptOverrides;
}): Promise<DetectHostsResult> {
  const startedAt = performance.now();
  const stats = speakerStats(input.transcript);
  const totalSeconds = stats.reduce((sum, s) => sum + s.seconds, 0);
  const fallback = (cacheHit: boolean, reason?: string): DetectHostsResult => {
    const hosts = heuristicHosts(stats, totalSeconds);
    const source = hosts.length > 0 ? "heuristic" : "none";
    if (reason !== undefined) logger().warn("llm", "主播识别回退统计", { reason, speakerCount: stats.length });
    logger().info("llm", "主播识别完成", { hostCount: hosts.length, source, cacheHit, durationMs: Math.round(performance.now() - startedAt) });
    return { hosts, source };
  };
  if (stats.length === 0 || totalSeconds <= 0) return fallback(false, "没有说话人统计");

  const topLevelIds = new Set(stats.map((s) => s.id as string));
  let rendered: string;
  let client: LlmClient;
  try {
    const examples = exampleLines(input.transcript, topLevelIds);
    const block = stats.map((s) => speakerLine(s, totalSeconds, examples.get(s.id as string) ?? [])).join("\n");
    rendered = renderPrompt("host-detect", { SPEAKERS: block, LANGUAGE_HINT: "字幕是中文" }, input.prompts);
    client = input.client ?? createLlmClient(input.endpoint);
  } catch (err) {
    return fallback(false, err instanceof Error ? err.message : String(err));
  }

  const key = cacheKey("host-detect", {
    speakers: hashJson(stats),
    prompt: hashJson(rendered),
    model: input.endpoint.model,
  });
  let cacheHit = false;
  let ids: string[];
  try {
    const cached = readCache<RawHostResponse>(input.cacheDir, key);
    if (cached !== undefined) {
      cacheHit = true;
      ids = hostIdsOf(cached);
    } else {
      const text = await client.chat(
        [
          { role: "system", content: rendered },
          { role: "user", content: '只输出 JSON：{"hosts":[string]}，hosts 里的 id 必须来自说话人列表。' },
        ],
        { json: true },
      );
      const raw = parseJsonLoose<RawHostResponse>(text);
      ids = hostIdsOf(raw);
      // 全是编造的 id 不进缓存：下次仍要重新问模型，别让一次坏回答粘住
      if (ids.length > 0) {
        try {
          writeCache(input.cacheDir, key, { hosts: ids });
        } catch (err) {
          logger().warn("llm", "主播识别缓存写入失败", { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  } catch (err) {
    return fallback(cacheHit, err instanceof Error ? err.message : String(err));
  }

  const hosts: SpeakerId[] = [];
  for (const id of ids) {
    if (!topLevelIds.has(id) || hosts.includes(id as SpeakerId)) continue;
    hosts.push(id as SpeakerId);
  }
  if (hosts.length === 0) return fallback(cacheHit, "模型没有给出有效的说话人 id");
  logger().info("llm", "主播识别完成", { hostCount: hosts.length, source: "auto", cacheHit, durationMs: Math.round(performance.now() - startedAt) });
  return { hosts, source: "auto" };
}
