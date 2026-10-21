import { extractAudio, probeVideoDurations } from "../core/audio";
import { MODEL_DIR, NOTES_ROOT, llmSettingsFromEnv } from "../core/config";
import { applyCorrections } from "../core/corrections";
import { loadCorrections } from "../core/corrections-io";
import { ensureDir, openVideo, videoCacheDir } from "../core/paths";
import type { LlmClient, LlmEndpoint, Progress } from "../core/steps";
import type { Note, Topic, Video } from "../core/types";
import { generateNotes } from "./generate-notes";
import { segmentTopics } from "./segment-topics";
import { transcribeVideo } from "./transcribe";

export type ExtractInput = {
  videoPath: string;
  endpoint?: LlmEndpoint;
  /** 只处理视频前 N 秒。 */
  limitSeconds?: number;
  notesRoot?: string;
  modelDir?: string;
  client?: LlmClient;
  onProgress?: (p: Progress) => void;
};

export type ExtractResult = {
  video: Video;
  topics: Topic[];
  notes: Note[];
  indexMarkdown: string;
  timings: Record<string, number>;
  cacheHits: string[];
};

export async function runExtract(input: ExtractInput): Promise<ExtractResult> {
  const notesRoot = input.notesRoot ?? NOTES_ROOT;
  const modelDir = input.modelDir ?? MODEL_DIR;
  const endpoint = input.endpoint ?? llmSettingsFromEnv();
  if (endpoint === undefined) {
    throw new Error("未配置 LLM 端点：请设置 VNOTE_LLM_BASE_URL、VNOTE_LLM_API_KEY、VNOTE_LLM_MODEL（ADR-0005）");
  }
  const timings: Record<string, number> = {};
  const startedAt = performance.now();
  const t = () => Math.round((performance.now() - startedAt) / 10) / 100;

  const { duration } = await probeVideoDurations(input.videoPath);
  const video = openVideo(input.videoPath, duration, notesRoot);
  const cacheDir = ensureDir(videoCacheDir(video.outputDir));

  const wavPath = `${cacheDir}/audio.wav`;
  await extractAudio(video.sourcePath, wavPath, input.limitSeconds);
  timings.audio = t();

  const transcription = await transcribeVideo({
    video,
    wavPath,
    cacheDir,
    modelDir,
    ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
  });
  timings.transcribe = t();

  const corrections = loadCorrections(notesRoot, video.outputDir);
  const transcript = {
    speakers: transcription.transcript.speakers,
    utterances: applyCorrections(corrections, transcription.transcript.utterances),
  };

  const topicsStarted = performance.now();
  const { topics } = await segmentTopics({
    transcript,
    chunks: transcription.chunks,
    endpoint,
    cacheDir,
    ...(input.client !== undefined ? { client: input.client } : {}),
    ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
  });
  timings["segment-topics"] = Math.round((performance.now() - topicsStarted) / 10) / 100;

  const notesStarted = performance.now();
  const { notes, indexMarkdown } = await generateNotes({
    video,
    transcript,
    topics,
    selectedTopicIds: [],
    corrections,
    endpoint,
    cacheDir,
    ...(input.client !== undefined ? { client: input.client } : {}),
    ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
  });
  timings.notes = Math.round((performance.now() - notesStarted) / 10) / 100;
  timings.total = Math.round((performance.now() - startedAt) / 10) / 100;

  return { video, topics, notes, indexMarkdown, timings, cacheHits: transcription.cacheHits };
}
