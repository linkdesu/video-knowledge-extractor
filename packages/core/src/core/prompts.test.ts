import { describe, expect, test } from "bun:test";
import { sha256 } from "./cache";
import {
  PROMPT_SPECS,
  effectiveTemplate,
  promptFingerprint,
  promptSpec,
  promptVariableNames,
  renderPrompt,
  validatePromptTemplate,
} from "./prompts";

/** 旧 pipeline 里的 CHUNK_SYSTEM_PROMPT 原文（含末尾无换行），用来做逐字节对照。 */
const CHUNK_LITERAL =
  "你是视频主题分析器。只输出 JSON，不要解释。" +
  "只使用给出的时间戳，每个时间段必须落在该块范围内。" +
  "主题数 1-4，title 不超过 20 字，summary 不超过 60 字。" +
  "始终输出顶层对象，只有一个主题也要放进 topics 数组。" +
  '输出格式：{"topics":[{"title":string,"summary":string,"segments":[{"start":number,"end":number}]}]}';

/** 旧 pipeline 里的 MERGE_SYSTEM_PROMPT 原文。 */
const MERGE_LITERAL =
  "你是视频主题分析器。只输出 JSON，不要解释。" +
  "给出的是各分块的候选主题，把跨块属于同一主题的候选合并成一个主题，保留多个时间段。" +
  "只使用给出的时间戳。" +
  '输出格式：{"topics":[{"title":string,"summary":string,"segments":[{"start":number,"end":number}]}]}';

/** 旧 glossarySection 在有词条时的输出（末尾带换行，前面与提示词直接拼接）。 */
const GLOSSARY_LITERAL = "术语按下表正确写法：\n- 费雷德 → FireRed\n- 火红 → FireRed-ASR\n";

/** 旧 noteSystemPrompt 在给定主题/字幕/词条下拼出的全文。 */
const NOTE_LITERAL = `根据主题与字幕抽取 3-6 条要点，只输出 JSON {"keyPoints":[string]}。
术语按下表正确写法：
- 费雷德 → FireRed

主题：FireRed 训练
摘要：讲怎么用手环刷步数

字幕：
[00:00:05 - 00:00:12] 我们今天的主题是手环
[00:00:12 - 01:02:03] 摇一摇就能刷步数`;

/** 同上，但没有纠错词条时走「（无）」兜底。 */
const NOTE_NO_GLOSSARY_LITERAL = `根据主题与字幕抽取 3-6 条要点，只输出 JSON {"keyPoints":[string]}。
术语按下表正确写法：
（无）

主题：FireRed 训练
摘要：讲怎么用手环刷步数

字幕：
[00:00:05 - 00:00:12] 我们今天的主题是手环
[00:00:12 - 01:02:03] 摇一摇就能刷步数`;

/** 有主播段时：主播块紧贴在「术语按下表正确写法：」之前，上一行之后不多空行。 */
const NOTE_WITH_HOSTS_LITERAL = `根据主题与字幕抽取 3-6 条要点，只输出 JSON {"keyPoints":[string]}。
主播：s1（小夕）、s2（阿禾）
术语按下表正确写法：
（无）

主题：FireRed 训练
摘要：讲怎么用手环刷步数

字幕：
[00:00:05 - 00:00:12] 我们今天的主题是手环
[00:00:12 - 01:02:03] 摇一摇就能刷步数`;

describe("prompts 默认模板", () => {
  test("PROMPT_SPECS 的 id 唯一且默认模板里的占位符都已声明", () => {
    const ids = PROMPT_SPECS.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const spec of PROMPT_SPECS) {
      const used = [...spec.defaultTemplate.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)].map((m) => m[1]);
      expect(used.length).toBeGreaterThan(0);
      for (const name of used) {
        expect(spec.variables.map((v) => v.name)).toContain(name as string);
      }
    }
  });

  test("segment-chunk 默认渲染与旧的 CHUNK_SYSTEM_PROMPT + 术语表逐字节一致", () => {
    expect(renderPrompt("segment-chunk", { GLOSSARY: GLOSSARY_LITERAL })).toBe(CHUNK_LITERAL + GLOSSARY_LITERAL);
  });

  test("segment-chunk 缺变量时渲染成空串（等于无术语表的旧提示词）", () => {
    expect(renderPrompt("segment-chunk", {})).toBe(CHUNK_LITERAL);
  });

  test("segment-merge 默认渲染与旧的 MERGE_SYSTEM_PROMPT + 术语表逐字节一致", () => {
    expect(renderPrompt("segment-merge", { GLOSSARY: GLOSSARY_LITERAL })).toBe(MERGE_LITERAL + GLOSSARY_LITERAL);
  });

  test("segment-merge 多传的变量被忽略", () => {
    expect(renderPrompt("segment-merge", { GLOSSARY: "", TOPIC_TITLE: "不该出现" })).toBe(MERGE_LITERAL);
  });

  test("note-key-points 默认渲染与旧的 noteSystemPrompt 全文逐字节一致", () => {
    // 不传 HOSTS：空主播段不能凭空多出换行或空格。
    expect(
      renderPrompt("note-key-points", {
        GLOSSARY: "- 费雷德 → FireRed",
        TOPIC_TITLE: "FireRed 训练",
        TOPIC_SUMMARY: "讲怎么用手环刷步数",
        UTTERANCES: "[00:00:05 - 00:00:12] 我们今天的主题是手环\n[00:00:12 - 01:02:03] 摇一摇就能刷步数",
      }),
    ).toBe(NOTE_LITERAL);
    expect(promptVariableNames("note-key-points")).toEqual([
      "HOSTS",
      "GLOSSARY",
      "TOPIC_TITLE",
      "TOPIC_SUMMARY",
      "UTTERANCES",
    ]);
  });

  test("note-key-points 无纠错时「（无）」兜底位置不变", () => {
    expect(
      renderPrompt("note-key-points", {
        GLOSSARY: "（无）",
        TOPIC_TITLE: "FireRed 训练",
        TOPIC_SUMMARY: "讲怎么用手环刷步数",
        UTTERANCES: "[00:00:05 - 00:00:12] 我们今天的主题是手环\n[00:00:12 - 01:02:03] 摇一摇就能刷步数",
      }),
    ).toBe(NOTE_NO_GLOSSARY_LITERAL);
  });

  test("note-key-points 有主播段时渲染在术语行之前", () => {
    expect(
      renderPrompt("note-key-points", {
        HOSTS: "主播：s1（小夕）、s2（阿禾）\n",
        GLOSSARY: "（无）",
        TOPIC_TITLE: "FireRed 训练",
        TOPIC_SUMMARY: "讲怎么用手环刷步数",
        UTTERANCES: "[00:00:05 - 00:00:12] 我们今天的主题是手环\n[00:00:12 - 01:02:03] 摇一摇就能刷步数",
      }),
    ).toBe(NOTE_WITH_HOSTS_LITERAL);
  });

  test("host-detect 默认模板声明了 SPEAKERS 与 LANGUAGE_HINT 且能渲染", () => {
    expect(promptVariableNames("host-detect")).toEqual(["SPEAKERS", "LANGUAGE_HINT"]);
    const text = renderPrompt("host-detect", { SPEAKERS: "s1: 20 句", LANGUAGE_HINT: "请用中文输出" });
    expect(text).toContain('{"hosts":[string]}');
    expect(text).toContain("s1: 20 句");
    expect(text).toContain("请用中文输出");
  });

  test("每个 spec 都能按 id 取回且变量名不重复", () => {
    for (const spec of PROMPT_SPECS) {
      expect(promptSpec(spec.id)).toBe(spec);
      const names = promptVariableNames(spec.id);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe("validatePromptTemplate", () => {
  test("空模板被拒绝", () => {
    expect(validatePromptTemplate("segment-merge", "   \n\t ")).toEqual({ ok: false, error: "提示词不能为空。" });
  });

  test("未知占位符被拒绝且错误消息里列出占位符名", () => {
    const result = validatePromptTemplate("segment-chunk", "只输出 JSON。{{GLOSSARY}}{{GREETING}}");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("GREETING");
      expect(result.error).toContain("GLOSSARY");
    }
  });

  test("花括号不配对被拒绝", () => {
    for (const text of ["前 {{GLOSSARY 后", "前 GLOSSARY}} 后", "{{GLOSSARY{{X}}"]) {
      const result = validatePromptTemplate("segment-chunk", text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("花括号不配对");
    }
  });

  test("可以完全不用变量", () => {
    expect(validatePromptTemplate("note-key-points", "只输出 JSON。")).toEqual({ ok: true });
  });
});

describe("override 与回退", () => {
  test("覆盖模板按变量渲染", () => {
    const overrides = { "segment-chunk": "只输出 JSON。{{GLOSSARY}}" };
    expect(renderPrompt("segment-chunk", { GLOSSARY: GLOSSARY_LITERAL }, overrides)).toBe(
      `只输出 JSON。${GLOSSARY_LITERAL}`,
    );
  });

  test("无效的覆盖模板在渲染时抛错", () => {
    expect(() => renderPrompt("segment-chunk", {}, { "segment-chunk": "坏的 {{NOPE}}" })).toThrow(/未知占位符：NOPE/);
    expect(() => renderPrompt("segment-chunk", {}, { "segment-chunk": "  " })).not.toThrow();
  });

  test("effectiveTemplate 对空覆盖回退到默认模板", () => {
    const fallback = promptSpec("segment-merge").defaultTemplate;
    expect(effectiveTemplate("segment-merge", { "segment-merge": "   " })).toBe(fallback);
    expect(effectiveTemplate("segment-merge")).toBe(fallback);
    expect(effectiveTemplate("segment-merge", { "segment-merge": "坏的 {{NOPE}}" })).toBe(fallback);
    expect(effectiveTemplate("segment-merge", { "segment-merge": "{{GLOSSARY}}" })).toBe("{{GLOSSARY}}");
  });
});

describe("promptFingerprint", () => {
  const HEX64 = /^[0-9a-f]{64}$/;

  test("default template: source is default and sha256 is the full digest of the rendered text", () => {
    const rendered = renderPrompt("segment-chunk", { GLOSSARY: GLOSSARY_LITERAL });
    const fingerprint = promptFingerprint("segment-chunk", rendered);
    expect(fingerprint).toEqual({ id: "segment-chunk", source: "default", sha256: sha256(rendered) });
    expect(fingerprint.sha256).toMatch(HEX64);
    // same text, same digest: the fingerprint is stable across runs
    expect(promptFingerprint("segment-chunk", rendered).sha256).toBe(fingerprint.sha256);
  });

  test("custom override: source is custom and the sha differs from the default render", () => {
    const overrides = { "note-key-points": "只输出 JSON。" };
    const rendered = renderPrompt("note-key-points", {}, overrides);
    const custom = promptFingerprint("note-key-points", rendered, overrides);
    const fallback = promptFingerprint("note-key-points", renderPrompt("note-key-points", {}));
    expect(custom.id).toBe("note-key-points");
    expect(custom.source).toBe("custom");
    expect(custom.sha256).toBe(sha256(rendered));
    expect(custom.sha256).toMatch(HEX64);
    expect(custom.sha256).not.toBe(fallback.sha256);
  });

  test("invalid override that fell back to the default reports default with the default sha", () => {
    const rendered = renderPrompt("segment-merge", { GLOSSARY: "" });
    const fellBack = promptFingerprint("segment-merge", rendered, { "segment-merge": "坏的 {{NOPE}}" });
    expect(fellBack.source).toBe("default");
    expect(fellBack.sha256).toBe(promptFingerprint("segment-merge", rendered).sha256);
  });

  test("blank override is not custom", () => {
    const rendered = renderPrompt("segment-chunk", {});
    expect(promptFingerprint("segment-chunk", rendered, { "segment-chunk": "   \n" }).source).toBe("default");
    // an override for a different id does not make this one custom
    expect(promptFingerprint("segment-chunk", rendered, { "host-detect": "别的模板" }).source).toBe("default");
  });
});
