import { openSync, readFileSync, chmodSync, renameSync, writeSync, closeSync } from "node:fs";
import { logger } from "@video-notes/core";

/**
 * 密钥只存在于主进程（ADR-0015 §3）。r44 起不再使用 Electron safeStorage：
 * macOS 上它把加密钥匙存进登录钥匙串并绑定二进制 cdhash，本地 ad-hoc 签名每次重装都会弹钥匙串授权框。
 * 现在 secrets.bin 是 0o600 权限的本地 JSON 文件（仅当前用户可读），不触碰系统钥匙串。
 */

/** 五个密钥位（ADR-0016 §5）：`asr` 沿用 r23 的 OpenAI 兼容 key，不迁移已存值。 */
export const SECRET_IDS = ["llm", "asr", "volcApiKey", "volcAppKey", "volcAccessKey"] as const;

export type SecretId = (typeof SECRET_IDS)[number];

/** 编解码边界：生产用 plainFileCodec（不碰钥匙串），单测注入假实现（往返与坏密文）。 */
export type SecretCodec = {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
};

/** 内容不是 JSON（空文件、乱码、旧版密文）：无法解析，由调用方决定备份与提示。 */
export class UnreadableSecretFile extends Error {
  constructor() {
    super("密钥文件内容不是 JSON");
    this.name = "UnreadableSecretFile";
  }
}

/**
 * 旧版 Electron safeStorage 密文（r64）：Electron 自己的 decryptString 只接受 `v10` / `v11` 前缀，
 * 所以只有这两种开头才可能是“旧密钥”。空文件、BOM、乱码都不是，不能被当成迁移对象——
 * 那是 r45c 的误报来源（r45 QA GAP-1）。
 */
export function looksLikeLegacyCipher(cipher: Buffer): boolean {
  const head = cipher.subarray(0, 3).toString("utf8");
  return head === "v10" || head === "v11";
}

/** 生产 codec：UTF-8 明文 JSON + 0o600；以 `{` 开头之外的字节抛 UnreadableSecretFile。 */
export const plainFileCodec: SecretCodec = {
  available: () => true,
  encrypt: (plain: string) => Buffer.from(plain, "utf8"),
  decrypt: (cipher: Buffer) => {
    const text = cipher.toString("utf8");
    if (!text.trimStart().startsWith("{")) throw new UnreadableSecretFile();
    return text;
  },
};

/**
 * 把无法读取的文件挪到旁边（不删除，便于排查；后缀 `.legacy-` 也是证据门禁的扫描目标）。
 * 返回备份路径，挪不动返回 null。只做文件动作，提示由知道上下文（迁移成功/失败）的调用方写。
 */
export function setAsideUnreadable(path: string): string | null {
  const target = `${path}.legacy-${Date.now()}`;
  try {
    renameSync(path, target);
    return target;
  } catch {
    return null;
  }
}

/** 二进制原子写：临时文件 0o600 → 写 → rename → 0o600；rename 前的权限窗口不暴露目标名。 */
export function writeBinaryAtomic(path: string, data: Buffer): void {
  const tmp = `${path}.tmp-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
  const handle = openSync(tmp, "w", 0o600);
  try {
    const written = writeSync(handle, data);
    if (written !== data.length) throw new Error("写入不完整");
  } finally {
    closeSync(handle);
  }
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // 文件系统不支持位权限：保持创建时的 0o600
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // 同上
  }
}

export type LegacyMigrationResult = "none" | "migrated" | "failed";

/** 进程内密钥表：文件是 codec.encrypt(JSON({version:2, llm?, asr?, volcApiKey?, volcAppKey?, volcAccessKey?})) 的二进制。 */
export type SecretStore = {
  available(): boolean;
  has(id: SecretId): boolean;
  get(id: SecretId): string | undefined;
  /** 空串按 clear。 */
  set(id: SecretId, secret: string): void;
  clear(id: SecretId): void;
  /** 只给 sanitizeError 脱敏，不进 IPC、不进日志。 */
  all(): string[];
  /** 解密/IO 失败的可读原因，界面显示。 */
  error(): string | null;
  /**
   * r64：旧版 safeStorage 密文的一次性迁移，需要平台提供异步解密（Windows 的 DPAPI）。
   * 没有旧密文时返回 "none"，既不调用 decrypt 也不写任何迁移日志；decrypt 为 null 表示该平台不提供解密。
   */
  migrateLegacy(decrypt: ((cipher: Buffer) => Promise<string>) | null): Promise<LegacyMigrationResult>;
};

type StoreImpl = {
  file: string;
  codec: SecretCodec;
  values: Partial<Record<SecretId, string>>;
  loadError: string | null;
  /** r64：读到的旧版 safeStorage 密文与它的备份路径，等 migrateLegacy 决定能否迁回。 */
  legacy: { cipher: Buffer; backup: string | null } | null;
};

function failLoad(s: StoreImpl, message: string): void {
  // 保留原文件不覆盖；只有显式 set/clear 才重写
  s.values = {};
  s.loadError = message;
}

/** 解析已解密的密钥 JSON；形状不对抛错（调用方转成 failLoad / 迁移失败）。 */
function parseSecretPlain(plain: string): Partial<Record<SecretId, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    throw new Error("密钥文件内容不是合法 JSON（原文件已保留）");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("密钥文件内容不是对象（原文件已保留）");
  }
  const obj = parsed as Record<string, unknown>;
  const version = obj.version;
  if (version !== 1 && version !== 2) {
    throw new Error(`密钥文件版本不支持（原文件已保留）：${JSON.stringify(version)}`);
  }
  // v1 只有 llm/asr；v2 五个字段都接受。两边都只接受非空字符串，坏形状整份视为没有已存 key。
  const ids = version === 1 ? (["llm", "asr"] as const) : SECRET_IDS;
  const next: Partial<Record<SecretId, string>> = {};
  for (const id of ids) {
    const value = obj[id];
    if (value === undefined) continue;
    if (typeof value !== "string" || value === "") {
      throw new Error(`密钥文件字段 ${id} 不是非空字符串（原文件已保留）`);
    }
    next[id] = value;
  }
  return next;
}

function readStored(s: StoreImpl): void {
  s.loadError = null;
  let cipher: Buffer;
  try {
    cipher = readFileSync(s.file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    s.loadError = `密钥文件读取失败：${(err as Error).message}`;
    return;
  }
  let plain: string;
  try {
    plain = s.codec.decrypt(cipher);
  } catch (err) {
    if (err instanceof UnreadableSecretFile) {
      const backup = setAsideUnreadable(s.file);
      s.values = {};
      if (looksLikeLegacyCipher(cipher)) {
        // 旧版 safeStorage 密文：备份已留，能否迁回由 migrateLegacy 决定（r64 起用异步 API）
        s.legacy = { cipher, backup };
        return;
      }
      // 不是 JSON 也不是旧版密文（空文件、BOM、乱码）：按“内容无法识别”处理，绝不冒充旧密钥迁移
      logger().warn("app", "密钥文件内容无法识别，已备份并重置", { backup });
      return;
    }
    failLoad(s, `密钥文件解密失败（原文件已保留）：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  try {
    s.values = parseSecretPlain(plain);
  } catch (err) {
    failLoad(s, err instanceof Error ? err.message : String(err));
  }
}

function persist(s: StoreImpl): void {
  if (!s.codec.available()) throw new Error("本机私有密钥文件不可写，无法保存密钥");
  const body: { version: 2 } & Partial<Record<SecretId, string>> = { version: 2 };
  for (const id of SECRET_IDS) {
    const value = s.values[id];
    if (value !== undefined) body[id] = value;
  }
  try {
    writeBinaryAtomic(s.file, s.codec.encrypt(JSON.stringify(body)));
  } catch (err) {
    throw new Error(`密钥保存失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

export function createSecretStore(input: { file: string; codec: SecretCodec }): SecretStore {
  const store: StoreImpl = { file: input.file, codec: input.codec, values: {}, loadError: null, legacy: null };
  readStored(store);
  return {
    available() {
      return store.codec.available();
    },
    has(id) {
      return store.values[id] !== undefined;
    },
    get(id) {
      return store.values[id];
    },
    set(id, secret) {
      if (secret === "") {
        delete store.values[id];
      } else {
        store.values[id] = secret;
      }
      persist(store);
    },
    clear(id) {
      delete store.values[id];
      persist(store);
    },
    all() {
      const out: string[] = [];
      for (const id of SECRET_IDS) {
        const v = store.values[id];
        if (v !== undefined) out.push(v);
      }
      return out;
    },
    error() {
      return store.loadError;
    },
    async migrateLegacy(decrypt) {
      const legacy = store.legacy;
      if (legacy === null) return "none";
      store.legacy = null;
      if (decrypt === null) {
        // macOS：钥匙串绑 cdhash，重装后只会弹授权框（r44 的决定），只留备份与一条 WARN
        logger().warn("app", "旧版系统加密密钥无法自动迁移，已保留备份", {
          backup: legacy.backup,
          platform: process.platform,
        });
        return "failed";
      }
      try {
        const migrated = parseSecretPlain(await decrypt(legacy.cipher));
        store.values = migrated;
        persist(store);
        logger().info("app", "旧版系统加密密钥已迁移到本地密钥文件", { keys: Object.keys(migrated) });
        return "migrated";
      } catch (err) {
        // 旧密文解不开：备份文件已在 .legacy-*，用户在设置页重新填写一次即可；日志里留下原因
        logger().warn("app", "旧版系统加密密钥无法迁移，已保留备份", {
          backup: legacy.backup,
          reason: err instanceof Error ? err.message : String(err),
        });
        return "failed";
      }
    },
  };
}
