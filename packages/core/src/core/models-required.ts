import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { modelFileSpecs } from "../asr/sherpa";

export type RequiredModelId = "asr" | "diarization" | "speaker-embedding" | "punctuation";
export type RequiredModel = {
  id: RequiredModelId;
  label: string;
  relativePaths: string[];
  ready: boolean;
  missing: string[];
};
export type ModelsCheck = { modelDir: string; ready: boolean; models: RequiredModel[] };

// 显示顺序与卡片文案；文件清单直接取 modelFileSpecs（与 runtime 同一事实源），
// 相对路径是 spec.path 去掉 modelDir 前缀的部分，避免两份清单漂移。
const GROUPS: { id: RequiredModelId; label: string; roles: string[] }[] = [
  { id: "asr", label: "识别（FireRed ASR2 CTC）", roles: ["asr-model", "asr-tokens"] },
  { id: "diarization", label: "说话人分离（PyAnnote 3.0）", roles: ["diarization"] },
  { id: "speaker-embedding", label: "说话人嵌入（CAM++ 中文）", roles: ["speaker-embedding"] },
  { id: "punctuation", label: "标点（Punct CTC Transformer）", roles: ["punctuation"] },
];

export function checkModels(modelDir: string): ModelsCheck {
  const specs = modelFileSpecs(modelDir);
  const models: RequiredModel[] = GROUPS.map((group) => {
    const relativePaths = group.roles
      .map((role) => {
        const path = specs.find((s) => s.role === role)?.path;
        if (path === undefined) return "";
        // 用 relative 而不是拼 `${modelDir}/`：Windows 的分隔符是反斜杠（r40）
        const rel = relative(modelDir, path);
        return rel.startsWith("..") ? "" : rel;
      })
      .filter((p) => p !== "");
    const missing = relativePaths.filter((p) => !existsSync(join(modelDir, p)));
    return { id: group.id, label: group.label, relativePaths, ready: missing.length === 0, missing };
  });
  return { modelDir, ready: models.every((m) => m.ready), models };
}
