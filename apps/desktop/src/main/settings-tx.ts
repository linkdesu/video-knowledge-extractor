import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { saveSettings, validateSettingsPatch } from "@video-notes/core/storage";
import type { SettingsPatch as CoreSettingsPatch, AppSettings, EnvRecord } from "@video-notes/core/storage";
import type { SecretPatch } from "../shared/ipc";
import { SECRET_IDS, writeBinaryAtomic, type SecretCodec, type SecretId, type SecretStore } from "./secrets";

/**
 * 端点与密钥分属 settings.json 与 secrets.bin，两份文件之间进程崩溃会留下「新地址配旧 key」的半套。
 * 事务语义（ADR-0015 §3，ADR-0016 §5）：先加密写 pending 记录，再幂等地 saveSettings → secrets.set/clear → 删 pending。
 * 任一步失败保留 pending；启动时 replayCredentialTransaction 幂等重放。
 * 密钥变更是三种互斥动作之一（set / clear / 无动作）：纯端点更新不触碰密钥，重放也不会误清。
 * 一次更新只改一个密钥；新提交前必须先重放旧 pending，失败就拒绝覆盖。
 */

type SecretChange = { id: SecretId } & (
  | { kind: "set"; value: string }
  | { kind: "clear" }
  | { kind: "none" }
);

type PendingTx = {
  txId: string;
  createdAt: string;
  settings: CoreSettingsPatch;
  secret: SecretChange;
};

const PENDING_FILE_NAME = "secrets.pending";

function pendingPath(userData: string): string {
  return join(userData, PENDING_FILE_NAME);
}

function writePending(userData: string, codec: SecretCodec, tx: PendingTx): void {
  writeBinaryAtomic(pendingPath(userData), codec.encrypt(JSON.stringify(tx)));
}

/**
 * r23 留下的 pending.settings 是 v2 形状（`asr.provider: "remote"`、`asr.remote`），它不经过设置文件的读时迁移。
 * 重放前在内存里转成 v3 patch：provider `remote` → `openai`，`remote` 块 → `openai` 块；已有 `openai` 时以它为准。
 */
function normalizePendingSettings(settings: CoreSettingsPatch): CoreSettingsPatch {
  const raw = settings as unknown as Record<string, unknown>;
  const asr = raw.asr;
  if (typeof asr !== "object" || asr === null || Array.isArray(asr)) return settings;
  const block = asr as Record<string, unknown>;
  const nextAsr: Record<string, unknown> = { ...block };
  delete nextAsr.remote;
  if (nextAsr.provider === "remote") nextAsr.provider = "openai";
  if (block.remote !== undefined && block.openai === undefined) nextAsr.openai = block.remote;
  return { ...raw, asr: nextAsr } as CoreSettingsPatch;
}

function readPending(userData: string, codec: SecretCodec): { tx: PendingTx | null; error: string | null } {
  let cipher: Buffer;
  try {
    cipher = readFileSync(pendingPath(userData));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { tx: null, error: null };
    return { tx: null, error: `pending 事务读取失败：${(err as Error).message}` };
  }
  let plain: string;
  try {
    plain = codec.decrypt(cipher);
  } catch (err) {
    // 保留原文件不静默丢弃（ADR-0015 §3）
    return { tx: null, error: `pending 事务解密失败（原文件已保留）：${err instanceof Error ? err.message : String(err)}` };
  }
  let parsed: Partial<PendingTx>;
  try {
    parsed = JSON.parse(plain) as Partial<PendingTx>;
  } catch {
    return { tx: null, error: "pending 事务内容不是合法 JSON（原文件已保留）" };
  }
  const settings = parsed.settings;
  const secret = parsed.secret;
  if (typeof parsed.txId !== "string" || typeof parsed.createdAt !== "string" || typeof settings !== "object" || settings === null || typeof secret !== "object" || secret === null) {
    return { tx: null, error: "pending 事务内容不完整（原文件已保留）" };
  }
  if (!(SECRET_IDS as readonly unknown[]).includes(secret.id)) return { tx: null, error: "pending 事务内容不完整（原文件已保留）" };
  if (secret.kind === "set") {
    if (typeof secret.value !== "string") return { tx: null, error: "pending 事务内容不完整（原文件已保留）" };
  } else if (secret.kind !== "clear" && secret.kind !== "none") {
    return { tx: null, error: "pending 事务内容不完整（原文件已保留）" };
  }
  return {
    tx: {
      txId: parsed.txId,
      createdAt: parsed.createdAt,
      settings: normalizePendingSettings(settings),
      // 上面已逐一校验 id 与 kind 分支，这里直接断言
      secret: secret as unknown as SecretChange,
    },
    error: null,
  };
}

function applySecret(secret: SecretChange, store: SecretStore): void {
  if (secret.kind === "clear") store.clear(secret.id);
  else if (secret.kind === "set") store.set(secret.id, secret.value);
}

/**
 * 提交一次「设置 + 密钥」更新。校验在写任何文件之前：
 * 先跑设置形状校验（不合法 baseUrl 等直接抛错，不碰 pending 与密钥存储）；
 * apiKey 与 clearApiKey 同传拒绝；带 apiKey 时存储必须可用。
 * 写新 pending 之前先重放旧 pending：重放失败就抛错，绝不覆盖旧记录（ADR-0016 §5 硬规则 1）。
 * 任一步失败保留 pending 并抛错，运行时保持旧值。
 */
export function commitCredentialUpdate(input: {
  userData: string;
  settingsFile: string;
  codec: SecretCodec;
  secretStore: SecretStore;
  settingsPatch: CoreSettingsPatch;
  secret: { id: SecretId; patch: SecretPatch };
  env?: EnvRecord;
}): AppSettings {
  const { userData, settingsFile, codec, secretStore, settingsPatch, secret } = input;
  const env = input.env ?? process.env;
  // 写 pending 与密钥存储之前先跑设置校验，坏输入不留下不可重放的 pending
  validateSettingsPatch(settingsFile, settingsPatch, env);
  const { apiKey, clearApiKey } = secret.patch;
  if (apiKey !== undefined && clearApiKey === true) {
    throw new Error("不能同时保存和清除 API key");
  }
  if (apiKey !== undefined && !secretStore.available()) {
    throw new Error(
      secret.id === "llm"
        ? "系统密钥存储不可用，无法保存密钥"
        : "系统密钥存储不可用，请用环境变量配置 ASR 密钥（VNOTE_ASR_API_KEY / VNOTE_VOLC_API_KEY / VNOTE_VOLC_APP_KEY / VNOTE_VOLC_ACCESS_KEY）",
    );
  }
  // 旧 pending 未清时先幂等重放；失败则抛错且不写新记录，否则第二次保存会丢掉第一笔未完成的更新。
  const replayError = replayCredentialTransaction({ userData, settingsFile, codec, secretStore });
  if (replayError !== null) throw new Error(replayError);
  const change: SecretChange =
    clearApiKey === true
      ? { id: secret.id, kind: "clear" }
      : apiKey !== undefined
        ? { id: secret.id, kind: "set", value: apiKey }
        : { id: secret.id, kind: "none" };
  const tx: PendingTx = {
    txId: randomUUID(),
    createdAt: new Date().toISOString(),
    settings: settingsPatch,
    secret: change,
  };
  writePending(userData, codec, tx);
  const settings = saveSettings(settingsFile, settingsPatch);
  applySecret(change, secretStore);
  // saveSettings 与密钥写入都成功才删 pending；上面任一步抛错则 pending 保留给重放
  rmSync(pendingPath(userData), { force: true });
  return settings;
}

/** 启动重放：读 pending → 幂等应用（saveSettings + 密钥写入）→ 删 pending。返回可暴露给设置页的错误，成功为 null。 */
export function replayCredentialTransaction(input: {
  userData: string;
  settingsFile: string;
  codec: SecretCodec;
  secretStore: SecretStore;
}): string | null {
  const { userData, settingsFile, codec, secretStore } = input;
  const { tx, error } = readPending(userData, codec);
  if (tx === null) return error;
  try {
    saveSettings(settingsFile, tx.settings);
    applySecret(tx.secret, secretStore);
    rmSync(pendingPath(userData), { force: true });
    return null;
  } catch (err) {
    // 重放失败：保留 pending，运行时保持旧值，错误暴露给设置页
    return `有未完成的凭据更新（${err instanceof Error ? err.message : String(err)}）`;
  }
}
