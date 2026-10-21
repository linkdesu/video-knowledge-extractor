import { isAbsolute } from "node:path";
import type { SettingsPatch as CoreSettingsPatch } from "@video-notes/core";
import type { SettingsPatch } from "../shared/ipc";

/**
 * updateSettings 的白名单重建（ADR-0015 §8）：只透传用户可编辑字段；
 * undefined 字段不写（不覆盖已有值），deep merge、env 锁定拒绝与校验交给 core saveSettings。
 * 独立模块：不 import electron，main 侧测试可直接加载。
 */
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
  if (patch.llm !== undefined) {
    clean.llm = {};
    if (patch.llm.baseUrl !== undefined) clean.llm.baseUrl = patch.llm.baseUrl;
    if (patch.llm.model !== undefined) clean.llm.model = patch.llm.model;
  }
  if (patch.asr !== undefined) {
    clean.asr = {};
    if (patch.asr.provider !== undefined) clean.asr.provider = patch.asr.provider;
    if (patch.asr.remote !== undefined) {
      clean.asr.remote = {};
      if (patch.asr.remote.baseUrl !== undefined) clean.asr.remote.baseUrl = patch.asr.remote.baseUrl;
      if (patch.asr.remote.model !== undefined) clean.asr.remote.model = patch.asr.remote.model;
    }
  }
  return clean;
}
