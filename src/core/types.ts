/**
 * 领域类型。命名与 `GLOSSARY.md` 一一对应；这里只放形状，不放行为。
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type VideoId = Brand<string, "VideoId">;
export type SpeakerId = Brand<string, "SpeakerId">;
export type TopicId = Brand<string, "TopicId">;

/** 用户导入的一个视频。 */
export type Video = {
  /** 首次生成时确定，之后不再变。 */
  id: VideoId;
  /** 显示标题，可改；改名不动 outputDir（ADR-0002）。 */
  title: string;
  /** 原始视频文件路径。 */
  sourcePath: string;
  durationSeconds: number;
  /** 该视频的输出目录，首次生成时确定，之后不再变（ADR-0002）。 */
  outputDir: string;
};

/** notes 根目录 `index.json` 的一条：id ↔ 输出目录 ↔ 显示标题。 */
export type VideoIndexEntry = Pick<Video, "id" | "title" | "outputDir">;

export type VideoIndex = { videos: VideoIndexEntry[] };

/** 一个字幕行归属的人；编号在整条视频范围内一致（ADR-0003）。 */
export type Speaker = {
  id: SpeakerId;
  /** 自动编号“说话人1”，用户可改。 */
  name: string;
  /** 用户可改。 */
  color: string;
};

/** 字幕行：转写与笔记都以它为单位。 */
export type Utterance = {
  /** 相对视频起点的秒数。 */
  start: number;
  end: number;
  speakerId: SpeakerId;
  text: string;
};

/** 拼接后的连续时间轴：说话人表 + 字幕行。 */
export type Transcript = {
  speakers: Speaker[];
  utterances: Utterance[];
};

/** 转写的处理与缓存单元；只决定粒度，不切断时间轴（ADR-0001）。 */
export type Chunk = {
  index: number;
  start: number;
  end: number;
};

/** 一个主题在时间轴上的一个起止区间；一个主题可有多个互不连续的时间段。 */
export type Segment = {
  start: number;
  end: number;
};

/** 笔记的单位：先自动划出，用户可改。 */
export type Topic = {
  id: TopicId;
  title: string;
  summary: string;
  segments: Segment[];
};

/** 从视频里切出的独立视频文件；按时间段生成，起点前移，重叠的时间段合一。 */
export type Clip = {
  topicId: TopicId;
  /** 切片实际覆盖的区间，已并入前移后的重叠。 */
  segment: Segment;
  path: string;
};

/** 一个主题的产物：`topic.md` 正文加上该主题的切片。 */
export type Note = {
  topicId: TopicId;
  markdown: string;
  clips: Clip[];
};

/** 纠错词条：识别错误原文 → 正确写法。 */
export type Correction = {
  from: string;
  to: string;
};

/** 纠错词表：全局一份 + 每视频一份；同原文冲突时视频专属优先（ADR-0005）。 */
export type CorrectionList = {
  global: Correction[];
  video: Correction[];
};
