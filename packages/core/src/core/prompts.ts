/**
 * 可编辑提示词的唯一来源：默认模板、变量声明、校验与渲染都从这里出。
 *
 * 为什么要单独一模块：提示词的措辞需要人来改（换模型、调口吻、加语言提示），
 * 但散落在 pipeline 各处的字符串拼接既没法在界面上列出来，也没法校验用户改坏的占位符。
 * 因此把「模板」与「取值」分开：pipeline 只负责算出变量，模板正文集中放这里。
 */

export type PromptId = "segment-chunk" | "segment-merge" | "note-key-points" | "host-detect";

export type PromptVariable = { name: string; description: string };

export type PromptSpec = {
  id: PromptId;
  title: string;
  description: string;
  variables: PromptVariable[];
  /** 默认模板：变量写成 {{NAME}}，渲染时整体替换。 */
  defaultTemplate: string;
};

export type PromptOverrides = Partial<Record<PromptId, string>>;

export type PromptValidation = { ok: true } | { ok: false; error: string };

/** 占位符只认大写标识符，免得把 JSON 样例里的单个花括号当成占位符。 */
const PLACEHOLDER_RE = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

const GLOSSARY_VARIABLE: PromptVariable = {
  name: "GLOSSARY",
  description: "纠错词表段（形如「术语按下表正确写法：」加若干「- 原文 → 正确写法」行）；没有纠错时传空字符串。",
};

/** 与 pipeline/segment-topics.ts 里原来的 CHUNK_SYSTEM_PROMPT 逐字一致，末尾直接接术语表段（无分隔符）。 */
const SEGMENT_CHUNK_TEMPLATE =
  "你是视频主题分析器。只输出 JSON，不要解释。" +
  "只使用给出的时间戳，每个时间段必须落在该块范围内。" +
  "主题数 1-4，title 不超过 20 字，summary 不超过 60 字。" +
  "始终输出顶层对象，只有一个主题也要放进 topics 数组。" +
  '输出格式：{"topics":[{"title":string,"summary":string,"segments":[{"start":number,"end":number}]}]}' +
  "{{GLOSSARY}}";

/** 与 pipeline/segment-topics.ts 里原来的 MERGE_SYSTEM_PROMPT 逐字一致，末尾直接接术语表段（无分隔符）。 */
const SEGMENT_MERGE_TEMPLATE =
  "你是视频主题分析器。只输出 JSON，不要解释。" +
  "给出的是各分块的候选主题，把跨块属于同一主题的候选合并成一个主题，保留多个时间段。" +
  "只使用给出的时间戳。" +
  '输出格式：{"topics":[{"title":string,"summary":string,"segments":[{"start":number,"end":number}]}]}' +
  "{{GLOSSARY}}";

/** 与 generate-notes.ts 里 noteSystemPrompt 拼出来的字符串一致：换行位置不动，只是把取值换成占位符。 */
const NOTE_KEY_POINTS_TEMPLATE = `根据主题与字幕抽取 3-6 条要点，只输出 JSON {"keyPoints":[string]}。
{{HOSTS}}术语按下表正确写法：
{{GLOSSARY}}

主题：{{TOPIC_TITLE}}
摘要：{{TOPIC_SUMMARY}}

字幕：
{{UTTERANCES}}`;

/** 主播识别的默认提示词：只看说话人列表就能判，不依赖主题与字幕切片。 */
const HOST_DETECT_TEMPLATE = `你是播客转写分析器。给定说话人列表（每人的统计与示例发言），找出这场谈话的主播。
主播 = 主要回答别人问题、抛出话题并做解释的人；提问、追问的人不是主播。
主播可以有多个，也可以只有一个。
别人的发言多是问题或补充上下文，用来判断谁在回答。
只输出 JSON，不要解释，不要用代码块包裹：{"hosts":[string]}
hosts 里的 id 必须来自给定的说话人列表，原样复制，不要编造。
说话人列表：
{{SPEAKERS}}
{{LANGUAGE_HINT}}`;

/** 顺序即界面上展示的顺序。 */
export const PROMPT_SPECS: readonly PromptSpec[] = [
  {
    id: "segment-chunk",
    title: "主题切分（单块）",
    description: "对单个字幕块抽取 1-4 个候选主题，输出 JSON。",
    variables: [GLOSSARY_VARIABLE],
    defaultTemplate: SEGMENT_CHUNK_TEMPLATE,
  },
  {
    id: "segment-merge",
    title: "主题合并",
    description: "把各分块的候选主题合并成最终主题，保留多个时间段。",
    variables: [GLOSSARY_VARIABLE],
    defaultTemplate: SEGMENT_MERGE_TEMPLATE,
  },
  {
    id: "note-key-points",
    title: "主题要点",
    description: "按主题与字幕抽取 3-6 条要点，输出 JSON。",
    variables: [
      { name: "HOSTS", description: "主播段，没有主播时为空串。" },
      {
        name: "GLOSSARY",
        description: "纠错词表行（每行「- 原文 → 正确写法」）；没有纠错时传「（无）」，与旧提示词保持一致。",
      },
      { name: "TOPIC_TITLE", description: "主题标题。" },
      { name: "TOPIC_SUMMARY", description: "主题摘要。" },
      { name: "UTTERANCES", description: "主题内字幕行，每行「[HH:MM:SS - HH:MM:SS] 文本」。" },
    ],
    defaultTemplate: NOTE_KEY_POINTS_TEMPLATE,
  },
  {
    id: "host-detect",
    title: "主播识别",
    description: "根据说话人统计与示例发言判断谁是主播，输出 JSON。",
    variables: [
      { name: "SPEAKERS", description: "说话人列表：每人的发言统计与示例发言。" },
      { name: "LANGUAGE_HINT", description: "可选的语言提示（例如「请用中文输出」）；没有时传空字符串。" },
    ],
    defaultTemplate: HOST_DETECT_TEMPLATE,
  },
];

/** id 是闭集（PromptId），用错类型编译期就报错，这里只是把查表失败兜成显式异常。 */
export function promptSpec(id: PromptId): PromptSpec {
  const spec = PROMPT_SPECS.find((s) => s.id === id);
  if (!spec) throw new Error(`未知提示词：${id}`);
  return spec;
}

/** 变量名列表：校验允许的占位符、做界面提示都用它。 */
export function promptVariableNames(id: PromptId): string[] {
  return promptSpec(id).variables.map((v) => v.name);
}

/**
 * 校验用户改过的模板：空模板、未知占位符、花括号不配对所有直接拒绝。
 * 允许完全不用变量（比如把术语表段删掉），只禁止写坏。
 */
export function validatePromptTemplate(id: PromptId, text: string): PromptValidation {
  if (text.trim() === "") return { ok: false, error: "提示词不能为空。" };

  const allowed = new Set(promptVariableNames(id));
  const unknown: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("{{", i)) {
      const close = text.indexOf("}}", i + 2);
      const nested = text.indexOf("{{", i + 2);
      if (close === -1 || (nested !== -1 && nested < close)) {
        return { ok: false, error: "提示词里的花括号不配对：每个 {{ 都要有对应的 }}。" };
      }
      const name = text.slice(i + 2, close);
      if (!allowed.has(name)) unknown.push(name);
      i = close + 2;
      continue;
    }
    if (text.startsWith("}}", i)) {
      return { ok: false, error: "提示词里的花括号不配对：多余的 }} 没有对应的 {{。" };
    }
    i += 1;
  }

  if (unknown.length > 0) {
    const names = [...new Set(unknown)].join("、");
    return { ok: false, error: `提示词里有未知占位符：${names}。可用占位符：${[...allowed].join("、")}。` };
  }
  return { ok: true };
}

/** 覆盖模板为空或写坏时一律回退到默认模板，保证调用方永远拿到能用的正文。 */
export function effectiveTemplate(id: PromptId, overrides?: PromptOverrides): string {
  const override = overrides?.[id];
  if (override !== undefined && override.trim() !== "" && validatePromptTemplate(id, override).ok) return override;
  return promptSpec(id).defaultTemplate;
}

/**
 * 渲染：先校验覆盖模板（写坏就直接抛错，不静默回退，免得用户以为改动生效了），
 * 再替换每个 {{NAME}}；vars 里多余的键忽略，缺的键按空字符串处理。
 */
export function renderPrompt(id: PromptId, vars: Record<string, string>, overrides?: PromptOverrides): string {
  const override = overrides?.[id];
  if (override !== undefined && override.trim() !== "") {
    const validation = validatePromptTemplate(id, override);
    if (!validation.ok) throw new Error(validation.error);
  }
  return effectiveTemplate(id, overrides).replace(PLACEHOLDER_RE, (_match, name: string) => vars[name] ?? "");
}
