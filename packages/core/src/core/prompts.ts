/**
 * 可编辑提示词的唯一来源：默认模板、变量声明、校验与渲染都从这里出。
 *
 * 为什么要单独一模块：提示词的措辞需要人来改（换模型、调口吻、加语言提示），
 * 但散落在 pipeline 各处的字符串拼接既没法在界面上列出来，也没法校验用户改坏的占位符。
 * 因此把「模板」与「取值」分开：pipeline 只负责算出变量，模板正文集中放这里。
 */
import { sha256 } from "./cache";

export type PromptId = "segment-chunk" | "segment-merge" | "note-key-points" | "host-detect" | "filler-filter";

export type PromptVariable = { name: string; description: string };

export type PromptSpec = {
  id: PromptId;
  title: string;
  description: string;
  variables: PromptVariable[];
  /** 默认模板：变量写成 {{NAME}}，渲染时整体替换。 */
  defaultTemplate: string;
  /**
   * 输出格式约束（r47）：模板必须包含这个片段，否则模型拿不到输出形状。
   * 保存时校验，缺了就提示；默认模板本身都满足。
   */
  outputContract: { marker: string; hint: string };
};

export type PromptOverrides = Partial<Record<PromptId, string>>;

export type PromptValidation = { ok: true } | { ok: false; error: string };

/** Which template produced the text that was actually sent to the model. */
export type PromptSource = "default" | "custom";

/** Identifies one LLM request's prompt without carrying any of its text. */
export type PromptFingerprint = { id: PromptId; source: PromptSource; sha256: string };

/** 占位符只认大写标识符，免得把 JSON 样例里的单个花括号当成占位符。 */
const PLACEHOLDER_RE = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

const GLOSSARY_VARIABLE: PromptVariable = {
  name: "GLOSSARY",
  description: "纠错词表段（形如「术语按下表正确写法：」加若干「- 原文 → 正确写法」行）；没有纠错时传空字符串。",
};

/** 主播段（r47）：只声明谁是主播，不做加权；没有主播时为空字符串。 */
const HOSTS_VARIABLE: PromptVariable = {
  name: "HOSTS",
  description: "主播段（形如「主播：A、B。…」并以换行结尾）；没有主播时传空字符串。",
};

/** 与 pipeline/segment-topics.ts 里原来的 CHUNK_SYSTEM_PROMPT 逐字一致；r47 前面加主播段（空串时逐字不变）。 */
const SEGMENT_CHUNK_TEMPLATE =
  "{{HOSTS}}" +
  "你是视频主题分析器。只输出 JSON，不要解释。" +
  "只使用给出的时间戳，每个时间段必须落在该块范围内。" +
  "主题数 1-4，title 不超过 20 字，summary 不超过 60 字。" +
  "始终输出顶层对象，只有一个主题也要放进 topics 数组。" +
  '输出格式：{"topics":[{"title":string,"summary":string,"segments":[{"start":number,"end":number}]}]}' +
  "{{GLOSSARY}}";

/** 与 pipeline/segment-topics.ts 里原来的 MERGE_SYSTEM_PROMPT 逐字一致；r47 前面加主播段（空串时逐字不变）。 */
const SEGMENT_MERGE_TEMPLATE =
  "{{HOSTS}}" +
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

/**
 * 语义空洞短句过滤（r76 / #109）的默认提示词：一次看一整批带编号的短句，只回要丢弃的编号。
 * 「拿不准就保留」是硬要求——误删有内容的句子比留下一句寒暄糟得多。
 * r76c：不再把「识别乱码/转写质量差」当丢弃类别（r76b QA 用它一次删掉 6 分钟录音里 20 秒的火腿对话），
 * 并把现场确认、状态反馈这类「很短但有事」的句子写成显式保留项。
 */
const FILLER_FILTER_TEMPLATE = `你是视频字幕清洗器。下面是从视频转写里挑出来的短句，每行一个编号。
只挑出「删掉不丢任何信息」的句子，用于从字幕里删掉。

可以丢弃的只有下面三类，而且整句只能是这类词本身（可以重复、带语气词和标点，不能有别的内容）：
- 纯问候与接通寒暄：哈喽、你好、喂、喂喂、能听见吗、听得到吗、在吗——整句只有问候和接通确认。
- 纯语气词或重复的空口头应答：嗯、啊、哦、对对、好的好的、明白明白、OK OK。
- 半截口头语：你就但是、然后、这个那个。

下面这些一律保留，即使很短、即使有错字：
- 带事实、数字、时间、人物、地点、物品、价格的句子。
- 提问、请求、指令、建议、观点、评价、承诺。
- 现场状态与连线反馈：听不清、太吵了、更吵了、你那里声音没有了、没声音、卡了、我关蓝牙、我再给你们说一下、听懂了吗、好了吗、现好了吗。
- 转写质量差、有错字或串词，但能看出在说具体的事：这是识别的问题，不是空话，照样保留。
- 拿不准的一律保留。

转写有没有错不是删除理由：只有整句完全属于上面三类才可以丢弃。
只输出 JSON，不要解释，不要用代码块包裹：{"drop":[number]}
drop 里只放要丢弃的句子编号，编号必须来自下面的列表；没列出的句子一律保留，没有要舍弃的就输出 {"drop":[]}。
drop 的元素也可以写成 {"index":number,"reason":string}，reason 用不超过 10 个字说明理由。
句子列表：
{{SENTENCES}}`;

/** 顺序即界面上展示的顺序。 */
export const PROMPT_SPECS: readonly PromptSpec[] = [
  {
    id: "segment-chunk",
    title: "主题切分（单块）",
    description:
      "对单个字幕块抽取 1-4 个候选主题，输出 JSON。主播段只声明谁是主播、不做加权；保存时必须保留输出格式 {\"topics\":[…]}。",
    variables: [HOSTS_VARIABLE, GLOSSARY_VARIABLE],
    defaultTemplate: SEGMENT_CHUNK_TEMPLATE,
    outputContract: { marker: '{"topics"', hint: '输出格式：{"topics":[{"title","summary","segments"}]}' },
  },
  {
    id: "segment-merge",
    title: "主题合并",
    description:
      "把各分块的候选主题合并成最终主题，保留多个时间段。主播段只声明谁是主播、不做加权；保存时必须保留输出格式 {\"topics\":[…]}。",
    variables: [HOSTS_VARIABLE, GLOSSARY_VARIABLE],
    defaultTemplate: SEGMENT_MERGE_TEMPLATE,
    outputContract: { marker: '{"topics"', hint: '输出格式：{"topics":[{"title","summary","segments"}]}' },
  },
  {
    id: "note-key-points",
    title: "主题要点",
    description: "按主题与字幕抽取 3-6 条要点，输出 JSON；保存时必须保留输出格式 {\"keyPoints\":[…]}。",
    variables: [
      HOSTS_VARIABLE,
      {
        name: "GLOSSARY",
        description: "纠错词表行（每行「- 原文 → 正确写法」）；没有纠错时传「（无）」，与旧提示词保持一致。",
      },
      { name: "TOPIC_TITLE", description: "主题标题。" },
      { name: "TOPIC_SUMMARY", description: "主题摘要。" },
      { name: "UTTERANCES", description: "主题内字幕行，每行「[HH:MM:SS - HH:MM:SS] 文本」。" },
    ],
    defaultTemplate: NOTE_KEY_POINTS_TEMPLATE,
    outputContract: { marker: '{"keyPoints"', hint: '输出格式：{"keyPoints":[string]}' },
  },
  {
    id: "host-detect",
    title: "主播识别",
    description: "根据说话人统计与示例发言判断谁是主播，输出 JSON；保存时必须保留输出格式 {\"hosts\":[…]}。",
    variables: [
      { name: "SPEAKERS", description: "说话人列表：每人的发言统计与示例发言。" },
      { name: "LANGUAGE_HINT", description: "可选的语言提示（例如「请用中文输出」）；没有时传空字符串。" },
    ],
    defaultTemplate: HOST_DETECT_TEMPLATE,
    outputContract: { marker: '{"hosts"', hint: '输出格式：{"hosts":[string]}' },
  },
  {
    id: "filler-filter",
    title: "空洞短句过滤",
    description:
      "把规则过滤剩下的短句按批交给模型，只回要丢弃的编号；保存时必须保留输出格式 {\"drop\":[…]}。",
    variables: [
      { name: "SENTENCES", description: "一批带编号的短句，每行「序号. 文本」；编号从 1 开始、批内连续。" },
    ],
    defaultTemplate: FILLER_FILTER_TEMPLATE,
    outputContract: { marker: '{"drop"', hint: '输出格式：{"drop":[number]}' },
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
  const contract = promptSpec(id).outputContract;
  if (!text.includes(contract.marker)) {
    return { ok: false, error: `提示词缺少输出格式约束：必须包含 ${contract.marker}（${contract.hint}）。` };
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

/**
 * Fingerprint the prompt that was actually rendered, for logs and the trajectory record.
 *
 * `source` reports which template the text came from, not what the user typed: an override only
 * counts as `"custom"` when it is a non-empty string that passes validation. An empty/whitespace
 * override, or an invalid one that `effectiveTemplate`/`renderPrompt` fell back on, is reported as
 * `"default"` because the default text is what the model actually received. `sha256` is the full
 * 64-hex digest of `rendered`, so it is stable for identical text across runs.
 */
export function promptFingerprint(id: PromptId, rendered: string, overrides?: PromptOverrides): PromptFingerprint {
  const override = overrides?.[id];
  const custom = override !== undefined && override.trim() !== "" && validatePromptTemplate(id, override).ok;
  return { id, source: custom ? "custom" : "default", sha256: sha256(rendered) };
}
