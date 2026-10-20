import type { Glossary } from "../glossary";

/** 统一转写结果：一句话一个说话人。 */
export type AsrUtterance = {
  start: number;
  end: number;
  speaker: string;
  text: string;
};

export type AsrProgress = {
  stage: string;
  done: number;
  total: number;
  detail?: string;
};

export type AsrOptions = {
  glossary?: Glossary;
  /** 是否尝试把术语作为热词交给识别器；adapter 不支持时必须在结果里说明。 */
  hotwords?: boolean;
  limit?: number;
  onProgress?: (p: AsrProgress) => void;
};

export type AsrCapabilities = {
  hotwords: boolean;
  diarization: boolean;
};

export type AsrRun = {
  provider: string;
  model: string;
  utterances: AsrUtterance[];
  capabilities: AsrCapabilities;
  /** 术语表实际生效方式：prompt / hotwords / replace / none */
  glossaryMode: "prompt" | "hotwords" | "replace" | "none";
  notes?: string[];
  timings: Record<string, number>;
};

export interface AsrAdapter {
  id: string;
  model: string;
  capabilities: AsrCapabilities;
  transcribe(audioPath: string, options?: AsrOptions): Promise<AsrRun>;
}
