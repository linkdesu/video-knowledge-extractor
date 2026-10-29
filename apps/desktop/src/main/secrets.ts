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

/** 旧版 safeStorage 密文（非 JSON 字节）：无法也不应再解密，调用方静默重置。 */
export class LegacyCipherError extends Error {
  constructor() {
    super("旧版系统加密密文，已不再支持");
    this.name = "LegacyCipherError";
  }
}

/** 生产 codec：UTF-8 明文 JSON + 0o600；以 `{` 开头之外的字节视为旧版 safeStorage 密文。 */
export const plainFileCodec: SecretCodec = {
  available: () => true,
  encrypt: (plain: string) => Buffer.from(plain, "utf8"),
  decrypt: (cipher: Buffer) => {
    const text = cipher.toString("utf8");
    if (!text.trimStart().startsWith("{")) throw new LegacyCipherError();
    return text;
  },
};

/** 把无法读取的旧文件挪到旁边（不删除，便于排查），返回是否成功。 */
export function setAsideLegacy(path: string): void {
  const target = `${path}.legacy-${Date.now()}`;
  try {
    renameSync(path, target);
  } catch {
    // 挪不动也不阻塞：下次 set 会覆盖
  }
  // r45c：旧版 safeStorage 密文只能丢弃，但不能静默——日志里留下备份路径，排查“重装后 key 没了”时有据可查
  logger().warn("app", "旧版系统加密密钥已失效，已备份并重置", { backup: target });
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
};

type StoreImpl = {
  file: string;
  codec: SecretCodec;
  values: Partial<Record<SecretId, string>>;
  loadError: string | null;
};

function failLoad(s: StoreImpl, message: string): void {
  // 保留原文件不覆盖；只有显式 set/clear 才重写
  s.values = {};
  s.loadError = message;
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
    if (err instanceof LegacyCipherError) {
      // 旧版 safeStorage 密文：静默重置为空，用户在设置页重新填写一次 key 即可
      setAsideLegacy(s.file);
      s.values = {};
      return;
    }
    failLoad(s, `密钥文件解密失败（原文件已保留）：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    failLoad(s, "密钥文件内容不是合法 JSON（原文件已保留）");
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    failLoad(s, "密钥文件内容不是对象（原文件已保留）");
    return;
  }
  const obj = parsed as Record<string, unknown>;
  const version = obj.version;
  if (version !== 1 && version !== 2) {
    failLoad(s, `密钥文件版本不支持（原文件已保留）：${JSON.stringify(version)}`);
    return;
  }
  // v1 只有 llm/asr；v2 五个字段都接受。两边都只接受非空字符串，坏形状整份视为没有已存 key。
  const ids = version === 1 ? (["llm", "asr"] as const) : SECRET_IDS;
  const next: Partial<Record<SecretId, string>> = {};
  for (const id of ids) {
    const value = obj[id];
    if (value === undefined) continue;
    if (typeof value !== "string" || value === "") {
      failLoad(s, `密钥文件字段 ${id} 不是非空字符串（原文件已保留）`);
      return;
    }
    next[id] = value;
  }
  s.values = next;
}

function persist(s: StoreImpl): void {
  if (!s.codec.available()) throw new Error("系统密钥存储不可用，无法保存密钥");
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
  const store: StoreImpl = { file: input.file, codec: input.codec, values: {}, loadError: null };
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
  };
}
