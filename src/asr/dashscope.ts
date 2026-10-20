import { statSync } from "node:fs";
import { basename } from "node:path";
import type { AsrAdapter, AsrOptions, AsrRun, AsrUtterance } from "./types";
import { applyGlossary } from "../glossary";

const DEFAULT_BASE = "https://dashscope.aliyuncs.com";

type SubmitResponse = {
  output?: { task_id?: string; task_status?: string };
  request_id?: string;
  message?: string;
  code?: string;
};

type TaskResponse = {
  output?: {
    task_status?: string;
    results?: { transcription_url?: string; subtask_status?: string; message?: string }[];
    message?: string;
  };
};

type TranscriptionFile = {
  transcripts?: {
    channel_id?: number;
    text?: string;
    sentences?: { begin_time?: number; end_time?: number; text?: string; speaker_id?: number }[];
  }[];
};

export type DashScopeOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** 测试或已有公网 URL 时直接给，跳过上传。 */
  fileUrl?: string;
  vocabularyId?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

function requireKey(key: string | undefined): string {
  if (!key) throw new Error("缺少 DASHSCOPE_API_KEY");
  return key;
}

/** 把本地音频上传到 DashScope 的临时 OSS，返回 oss:// URL。 */
async function uploadFile(path: string, opts: DashScopeOptions): Promise<string> {
  const key = requireKey(opts.apiKey);
  const base = opts.baseUrl ?? DEFAULT_BASE;
  const model = opts.model ?? "paraformer-v2";
  const policyRes = await fetch(`${base}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!policyRes.ok) throw new Error(`上传策略失败 HTTP ${policyRes.status}: ${(await policyRes.text()).slice(0, 300)}`);
  const policy = (await policyRes.json()) as {
    data?: {
      policy: string;
      signature: string;
      upload_dir: string;
      upload_host: string;
      oss_access_key_id: string;
      x_oss_object_acl: string;
      x_oss_forbid_overwrite: string;
    };
  };
  const d = policy.data;
  if (!d) throw new Error("上传策略返回缺少 data");
  const objectKey = `${d.upload_dir}/${basename(path)}`;
  const fd = new FormData();
  fd.append("policy", d.policy);
  fd.append("Signature", d.signature);
  fd.append("OSSAccessKeyId", d.oss_access_key_id);
  fd.append("key", objectKey);
  fd.append("x-oss-object-acl", d.x_oss_object_acl);
  fd.append("x-oss-forbid-overwrite", d.x_oss_forbid_overwrite);
  fd.append("file", Bun.file(path));
  const upload = await fetch(d.upload_host, { method: "POST", body: fd, signal: AbortSignal.timeout(600_000) });
  if (!upload.ok) throw new Error(`OSS 上传失败 HTTP ${upload.status}: ${(await upload.text()).slice(0, 300)}`);
  return `oss://${objectKey}`;
}

async function submit(fileUrl: string, opts: DashScopeOptions): Promise<string> {
  const key = requireKey(opts.apiKey);
  const base = opts.baseUrl ?? DEFAULT_BASE;
  const body = {
    model: opts.model ?? "paraformer-v2",
    input: { file_urls: [fileUrl] },
    parameters: {
      language_hints: ["zh", "en"],
      enable_diarization: true,
      ...(opts.vocabularyId ? { vocabulary_id: opts.vocabularyId } : {}),
    },
  };
  const res = await fetch(`${base}/api/v1/services/audio/asr/transcription`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`提交任务失败 HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = (await res.json()) as SubmitResponse;
  const taskId = data.output?.task_id;
  if (!taskId) throw new Error(`提交任务无 task_id: ${JSON.stringify(data).slice(0, 300)}`);
  return taskId;
}

async function waitTask(taskId: string, opts: DashScopeOptions): Promise<string> {
  const key = requireKey(opts.apiKey);
  const base = opts.baseUrl ?? DEFAULT_BASE;
  const interval = opts.pollIntervalMs ?? 3000;
  const deadline = Date.now() + (opts.timeoutMs ?? 1_800_000);
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`查询任务失败 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as TaskResponse;
    const status = data.output?.task_status;
    if (status === "SUCCEEDED") {
      const url = data.output?.results?.[0]?.transcription_url;
      if (!url) throw new Error("任务成功但没有 transcription_url");
      return url;
    }
    if (status === "FAILED" || status === "CANCELED") {
      throw new Error(`任务 ${status}: ${data.output?.message ?? "unknown"}`);
    }
    await Bun.sleep(interval);
  }
  throw new Error(`任务超时: ${taskId}`);
}

export function convertDashScopeResult(file: TranscriptionFile): AsrUtterance[] {
  const out: AsrUtterance[] = [];
  for (const transcript of file.transcripts ?? []) {
    for (const s of transcript.sentences ?? []) {
      const text = (s.text ?? "").trim();
      if (!text) continue;
      const start = (s.begin_time ?? 0) / 1000;
      const end = Math.max(start + 0.1, (s.end_time ?? 0) / 1000);
      out.push({ start, end, speaker: `S${(s.speaker_id ?? 0) + 1}`, text });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export class DashScopeAdapter implements AsrAdapter {
  id = "dashscope";
  model: string;
  capabilities = { hotwords: true, diarization: true };

  constructor(private opts: DashScopeOptions = {}) {
    this.model = opts.model ?? "paraformer-v2";
    this.opts.apiKey = opts.apiKey ?? process.env.DASHSCOPE_API_KEY;
    this.opts.baseUrl = opts.baseUrl ?? process.env.DASHSCOPE_BASE_URL ?? DEFAULT_BASE;
    this.opts.vocabularyId = opts.vocabularyId ?? process.env.DASHSCOPE_VOCABULARY_ID;
  }

  async transcribe(audioPath: string, options: AsrOptions = {}): Promise<AsrRun> {
    const timings: Record<string, number> = {};
    const notes: string[] = [];
    let fileUrl = this.opts.fileUrl;
    if (!fileUrl) {
      if (options.limit) {
        throw new Error("DashScope 适配器暂不支持 --limit 上传裁剪；请先裁剪音频或传入 fileUrl");
      }
      const size = statSync(audioPath).size;
      let t0 = performance.now();
      fileUrl = await uploadFile(audioPath, this.opts);
      timings.upload = (performance.now() - t0) / 1000;
      notes.push(`上传 ${(size / 1e6).toFixed(1)}MB`);
    }
    let t0 = performance.now();
    const taskId = await submit(fileUrl, this.opts);
    timings.submit = (performance.now() - t0) / 1000;
    t0 = performance.now();
    const url = await waitTask(taskId, this.opts);
    timings.wait = (performance.now() - t0) / 1000;
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`下载结果失败 HTTP ${res.status}`);
    const file = (await res.json()) as TranscriptionFile;
    let utterances = convertDashScopeResult(file);

    let glossaryMode: AsrRun["glossaryMode"] = "none";
    if (options.glossary && Object.keys(options.glossary.replace).length > 0) {
      utterances = utterances.map((u) => ({ ...u, text: applyGlossary(u.text, options.glossary!.replace) }));
      glossaryMode = this.opts.vocabularyId ? "hotwords" : "replace";
      notes.push(this.opts.vocabularyId ? `使用 vocabulary_id=${this.opts.vocabularyId}` : "未配置 vocabulary_id，仅做字面替换");
    }
    return {
      provider: "dashscope",
      model: this.model,
      utterances,
      capabilities: this.capabilities,
      glossaryMode,
      notes,
      timings,
    };
  }
}

