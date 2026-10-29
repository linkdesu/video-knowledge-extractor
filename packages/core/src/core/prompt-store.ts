/**
 * 提示词覆盖的落盘（r46）：`<userData>/prompts.json`。
 *
 * 形状 `{ version: 1, prompts: { <stepId>: "<template>" } }`；没有覆盖的步骤就用代码里的默认模板。
 * 读容错（坏文件、未知步骤、非字符串一律忽略，不影响启动），写原子（临时文件 + rename），
 * 保存前用 `validatePromptTemplate` 校验，非法模板以可读错误拒绝、不落盘。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROMPT_SPECS, validatePromptTemplate, type PromptId, type PromptOverrides, type PromptSpec } from "./prompts";

export const PROMPTS_FILE = "prompts.json";
export const PROMPTS_VERSION = 1;
/** 单步模板上限：默认模板都在 1KB 内，同时挡住误贴整份文档。 */
export const MAX_PROMPT_CHARS = 20000;

export type PromptsFile = { version: 1; prompts: PromptOverrides };

/** 落盘文件路径；测试与诊断都读这一个事实源。 */
export function promptsPath(userData: string): string {
  return join(userData, PROMPTS_FILE);
}

/** 未知步骤的覆盖丢弃：删掉一个步骤后旧文件仍可读。 */
export function parsePromptOverrides(raw: unknown): PromptOverrides {
  if (typeof raw !== "object" || raw === null || !("prompts" in raw)) return {};
  const prompts = raw.prompts;
  if (typeof prompts !== "object" || prompts === null) return {};
  const out: PromptOverrides = {};
  for (const [id, text] of Object.entries(prompts)) {
    if (!PROMPT_SPECS.some((spec) => spec.id === id)) continue;
    if (typeof text !== "string" || text.trim() === "") continue;
    out[id as PromptId] = text;
  }
  return out;
}

export function readPromptOverrides(userData: string): PromptOverrides {
  let text: string;
  try {
    text = readFileSync(promptsPath(userData), "utf8");
  } catch {
    return {};
  }
  try {
    return parsePromptOverrides(JSON.parse(text));
  } catch {
    return {};
  }
}

function writeOverrides(userData: string, overrides: PromptOverrides): void {
  const path = promptsPath(userData);
  mkdirSync(dirname(path), { recursive: true });
  const body: PromptsFile = { version: PROMPTS_VERSION, prompts: overrides };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
  renameSync(tmp, path);
}

/** 保存一个步骤的用户版本：未知步骤、空模板、未知变量、超长都以可读错误拒绝（不落盘）。 */
export function savePromptOverride(userData: string, id: string, text: string): PromptOverrides {
  const spec = PROMPT_SPECS.find((s) => s.id === id);
  if (spec === undefined) throw new Error(`未知的提示词步骤：${id}`);
  if (text.length > MAX_PROMPT_CHARS) throw new Error(`提示词过长（${text.length} 字符），上限 ${MAX_PROMPT_CHARS}`);
  const check = validatePromptTemplate(spec.id, text);
  if (!check.ok) throw new Error(check.error);
  const next: PromptOverrides = { ...readPromptOverrides(userData), [spec.id]: text };
  writeOverrides(userData, next);
  return next;
}

/** 恢复默认：只删该步骤的覆盖；没有覆盖时不写盘。 */
export function resetPromptOverride(userData: string, id: string): PromptOverrides {
  const spec = PROMPT_SPECS.find((s) => s.id === id);
  if (spec === undefined) throw new Error(`未知的提示词步骤：${id}`);
  const current = readPromptOverrides(userData);
  if (current[spec.id] === undefined) return current;
  const next: PromptOverrides = { ...current };
  delete next[spec.id];
  writeOverrides(userData, next);
  return next;
}

/** 界面用的投影：每个步骤的说明、变量、默认值与生效值。 */
export type PromptStatusDto = {
  id: PromptId;
  title: string;
  description: string;
  variables: PromptSpec["variables"];
  default: string;
  value: string;
  customized: boolean;
};

export function promptStatuses(overrides: PromptOverrides): PromptStatusDto[] {
  return PROMPT_SPECS.map((spec) => {
    const override = overrides[spec.id];
    const value = override !== undefined && override.trim() !== "" ? override : spec.defaultTemplate;
    return {
      id: spec.id,
      title: spec.title,
      description: spec.description,
      variables: spec.variables,
      default: spec.defaultTemplate,
      value,
      customized: value !== spec.defaultTemplate,
    };
  });
}
