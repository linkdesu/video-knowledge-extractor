import type { Clip, Note, SpeakerId, Topic, TopicId, Utterance, Video } from "./types";

function hms(seconds: number): string {
  const s = Math.floor(Math.max(0, seconds));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
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
    let turn: { speakerId: SpeakerId; texts: string[] } | undefined;
    for (const u of inSeg) {
      if (turn !== undefined && turn.speakerId === u.speakerId) {
        turn.texts.push(u.text);
        continue;
      }
      if (turn !== undefined) lines.push(`**${speakerNames.get(turn.speakerId) ?? turn.speakerId}**: ${turn.texts.join(" ")}`);
      turn = { speakerId: u.speakerId, texts: [u.text] };
    }
    if (turn !== undefined) lines.push(`**${speakerNames.get(turn.speakerId) ?? turn.speakerId}**: ${turn.texts.join(" ")}`);
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
