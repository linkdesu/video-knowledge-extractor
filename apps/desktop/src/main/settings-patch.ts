import { isAbsolute } from "node:path";
import type { SettingsPatch as CoreSettingsPatch } from "@video-notes/core";
import type { SettingsPatch } from "../shared/ipc";

/**
 * updateSettings 的白名单重建（ADR-0015 §8，ADR-0016 §9）：只透传用户可编辑字段；
 * undefined 字段不写（不覆盖已有值），deep merge、env 锁定拒绝与校验交给 core saveSettings。
 * 枚举在这里就拒绝：patch 路径不经过设置文件的读时迁移，坏值必须由有效值校验兜住。
 * 独立模块：不 import electron，main 侧测试可直接加载。
 */

/** 与 core 的 ASR_PROVIDERS / 火山枚举同值；main 侧白名单不依赖 core 的读时迁移。 */
const ASR_PROVIDERS = ["local", "openai", "volcengine"] as const;
const VOLCENGINE_MODES = ["flash", "standard"] as const;
const VOLCENGINE_AUTH_MODES = ["apiKey", "appAccessKey"] as const;

/** IPC 契约已不含 `remote`；旧 renderer 仍可能发来，这里显式识别并拒绝，不静默透传。 */
type AsrPatchInput = {
  provider?: unknown;
  openai?: unknown;
  volcengine?: unknown;
  remote?: unknown;
};

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`设置 ${path} 必须是 ${allowed.join(" / ")}，实际是 ${JSON.stringify(value)}`);
  }
  return value as T;
}

function assertString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`设置 ${path} 必须是字符串，实际是 ${JSON.stringify(value)}`);
  return value;
}

function asPlainObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`设置 ${path} 必须是对象`);
  return value as Record<string, unknown>;
}

export function buildSettingsPatch(patch: SettingsPatch): CoreSettingsPatch {
  const clean: CoreSettingsPatch = {};
  if (patch.notesRoot !== undefined) {
    if (!isAbsolute(patch.notesRoot) || patch.notesRoot === "") throw new Error("设置 notesRoot 必须是非空绝对路径");
    clean.notesRoot = patch.notesRoot;
  }
  if (patch.cacheRoot !== undefined) {
    if (!isAbsolute(patch.cacheRoot) || patch.cacheRoot === "") throw new Error("设置 cacheRoot 必须是非空绝对路径");
    clean.cacheRoot = patch.cacheRoot;
  }
  if (patch.modelDir !== undefined) {
    if (!isAbsolute(patch.modelDir) || patch.modelDir === "") throw new Error("设置 modelDir 必须是非空绝对路径");
    clean.modelDir = patch.modelDir;
  }
  if (patch.asr !== undefined) {
    const asr = patch.asr as AsrPatchInput;
    if (asr.remote !== undefined) throw new Error("设置 asr.remote 已废弃，请改用 asr.openai");
    const asrOut: NonNullable<CoreSettingsPatch["asr"]> = {};
    if (asr.provider !== undefined) asrOut.provider = assertEnum(asr.provider, ASR_PROVIDERS, "asr.provider");
    if (asr.openai !== undefined) {
      const block = asPlainObject(asr.openai, "asr.openai");
      asrOut.openai = {};
      if (block.baseUrl !== undefined) asrOut.openai.baseUrl = assertString(block.baseUrl, "asr.openai.baseUrl");
      if (block.model !== undefined) asrOut.openai.model = assertString(block.model, "asr.openai.model");
    }
    if (asr.volcengine !== undefined) {
      const block = asPlainObject(asr.volcengine, "asr.volcengine");
      asrOut.volcengine = {};
      if (block.mode !== undefined) asrOut.volcengine.mode = assertEnum(block.mode, VOLCENGINE_MODES, "asr.volcengine.mode");
      if (block.authMode !== undefined) {
        asrOut.volcengine.authMode = assertEnum(block.authMode, VOLCENGINE_AUTH_MODES, "asr.volcengine.authMode");
      }
    }
    clean.asr = asrOut;
  }
  return clean;
}
