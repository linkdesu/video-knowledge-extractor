import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { planClips, clipFileName, cutClip } from "../core/clips";
import { cacheKey, readCache, writeCache, hashJson } from "../core/cache";
import { ensureDir, topicDirNames } from "../core/paths";
import { resolveCorrections } from "../core/corrections";
import type { GenerateNotesInput, GenerateNotesResult, LlmClient } from "../core/steps";
import type { Clip, Note, SpeakerId, Topic, TopicId, Utterance, Video } from "../core/types";
import { createLlmClient, tryParseJson } from "../llm/openai";

function selectedTopics(input: GenerateNotesInput): Topic[] {
  const { topics, selectedTopicIds } = input;
  return selectedTopicIds.length === 0 ? topics : topics.filter((t) => selectedTopicIds.includes(t.id));
}

function topicUtterances(topic: Topic, all: Utterance[]): Utterance[] {
  return all.filter((u) => topic.segments.some((s) => u.end > s.start && u.start < s.end));
}

function hms(seconds: number): string {
  const s = Math.floor(Math.max(0, seconds));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

/** 要点提示词的纠错词表段：视频专属词条优先于全局（ADR-0005）。 */
function correctionLines(input: GenerateNotesInput): string {
  return resolveCorrections(input.corrections)
    .map((e) => `- ${e.from} → ${e.to}`)
    .join("\n");
}

/** 要点提示词全文；测试用它复算缓存键里的提示词哈希。 */
export function noteSystemPrompt(topic: Topic, utterances: Utterance[], input: GenerateNotesInput): string {
  const lines = utterances.map((u) => `[${hms(u.start)} - ${hms(u.end)}] ${u.text}`).join("\n");
  return (
    `根据主题与字幕抽取 3-6 条要点，只输出 JSON {"keyPoints":[string]}。\n` +
    `术语按下表正确写法：\n${correctionLines(input) || "（无）"}\n\n` +
    `主题：${topic.title}\n摘要：${topic.summary}\n\n字幕：\n${lines}`
  );
}

type KeyPoints = { keyPoints: string[] };

async function keyPointsFor(
  input: GenerateNotesInput,
  client: LlmClient,
  topic: Topic,
  utterances: Utterance[],
): Promise<string[]> {
  const system = noteSystemPrompt(topic, utterances, input);
  const key = cacheKey("note", {
    topic: hashJson(topic),
    transcript: hashJson(utterances.map((u) => [u.start, u.end, u.speakerId, u.text])),
    prompt: hashJson(system),
    model: input.endpoint.model,
    corrections: hashJson(input.corrections),
  });
  const hit = readCache<KeyPoints>(input.cacheDir, key);
  if (hit !== undefined) return hit.keyPoints;
  const raw = await client.chat([{ role: "system", content: system }], { json: true });
  const parsed = tryParseJson<{ keyPoints?: unknown }>(raw);
  if (parsed === undefined || !Array.isArray(parsed.keyPoints)) return [];
  const points = parsed.keyPoints.filter((p): p is string => typeof p === "string" && p.length > 0);
  writeCache(input.cacheDir, key, { keyPoints: points } satisfies KeyPoints);
  return points;
}

/** 该主题的 `topic.md`；要点由调用方算好传入。 */
export function renderTopicMarkdown(
  topic: Topic,
  utterances: Utterance[],
  keyPoints: string[],
  clips: Clip[],
  speakerNames: Map<SpeakerId, string>,
): string {
  const lines: string[] = [`# ${topic.title}`, ""];
  if (topic.summary.length > 0) lines.push(topic.summary, "");
  lines.push("## 要点", ...keyPoints.map((p) => `- ${p}`), "", "## 正文");
  for (const seg of [...topic.segments].sort((a, b) => a.start - b.start)) {
    const covering = clips.find((c) => c.segment.start <= seg.start && seg.start < c.segment.end) ?? clips[0];
    if (lines[lines.length - 1] !== "") lines.push("");
    lines.push(`### [${hms(seg.start)} - ${hms(seg.end)}](${covering?.path.split("/").pop() ?? ""})`);
    const inSeg = utterances.filter((u) => u.end > seg.start && u.start < seg.end).sort((a, b) => a.start - b.start);
    const bySpeaker = new Map<SpeakerId, string[]>();
    for (const u of inSeg) {
      const texts = bySpeaker.get(u.speakerId) ?? [];
      texts.push(u.text);
      bySpeaker.set(u.speakerId, texts);
    }
    // 段落按说话人首次出现顺序。
    for (const [id, texts] of bySpeaker) lines.push(`**${speakerNames.get(id) ?? id}**: ${texts.join(" ")}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderIndexMarkdown(video: Video, topics: Topic[], dirs: Map<TopicId, string>, notes: Note[]): string {
  const lines: string[] = [`# ${video.title}`, ""];
  const byId = new Map(notes.map((n) => [n.topicId, n]));
  const ordered = [...topics].sort(
    (a, b) => (a.segments[0]?.start ?? 0) - (b.segments[0]?.start ?? 0),
  );
  for (const topic of ordered) {
    const dir = dirs.get(topic.id);
    const note = byId.get(topic.id);
    if (dir === undefined || note === undefined) continue;
    let line = `- [${topic.title}](./${dir}/topic.md) — ${topic.summary}`;
    for (const clip of note.clips) line += ` [切片](./${dir}/${clip.path.split("/").pop()})`;
    lines.push(line);
  }
  return `${lines.join("\n")}\n`;
}

export async function generateNotes(input: GenerateNotesInput): Promise<GenerateNotesResult> {
  const client = input.client ?? createLlmClient(input.endpoint);
  const selected = selectedTopics(input);
  const speakerNames = new Map(input.transcript.speakers.map((s) => [s.id, s.name]));
  const dirs = topicDirNames(selected);
  const notes: Note[] = [];
  for (let i = 0; i < selected.length; i++) {
    const topic = selected[i];
    if (topic === undefined) continue;
    input.onProgress?.({ step: "generate-notes", done: i, total: selected.length, detail: topic.title });
    const dir = dirs.get(topic.id);
    if (dir === undefined) continue;
    const topicDir = ensureDir(resolve(input.video.outputDir, dir));
    const utterances = topicUtterances(topic, input.transcript.utterances);
    const keyPoints = await keyPointsFor(input, client, topic, utterances);
    const clips: Clip[] = [];
    const segments = planClips(topic.segments);
    for (let j = 0; j < segments.length; j++) {
      const segment = segments[j];
      if (segment === undefined) continue;
      const name = clipFileName(segment, j + 1);
      await cutClip({ videoPath: input.video.sourcePath, segment, outPath: join(topicDir, name) });
      clips.push({ topicId: topic.id, segment, path: join(topicDir, name) });
    }
    const markdown = renderTopicMarkdown(topic, utterances, keyPoints, clips, speakerNames);
    writeFileSync(join(topicDir, "topic.md"), markdown);
    notes.push({ topicId: topic.id, markdown, clips });
  }
  input.onProgress?.({ step: "generate-notes", done: selected.length, total: selected.length });
  const indexMarkdown = renderIndexMarkdown(input.video, selected, dirs, notes);
  writeFileSync(resolve(input.video.outputDir, "index.md"), indexMarkdown);
  return { notes, indexMarkdown };
}
