import { openSync, readFileSync, chmodSync, renameSync, writeSync, closeSync } from "node:fs";

/** 密钥只存在于主进程（ADR-0015 §3）：safeStorage 密文 + 自写原子写，绝不落盘明文。 */

export type SecretId = "llm" | "asr";

/** 加密器边界：Electron 用 safeStorage 包装，单测注入假实现（无 Electron 也能测往返与坏密文）。 */
export type SecretCodec = {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
};

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

/** 进程内密钥表：文件是 codec.encrypt(JSON({version:1, llm?, asr?})) 的二进制。 */
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
    // 保留原文件不覆盖；显式 set/clear 才重写
    s.values = {};
    s.loadError = `密钥文件解密失败（原文件已保留）：${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    s.values = {};
    s.loadError = "密钥文件内容不是合法 JSON（原文件已保留）";
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    s.values = {};
    s.loadError = "密钥文件内容不是对象（原文件已保留）";
    return;
  }
  const obj = parsed as Record<string, unknown>;
  const next: Partial<Record<SecretId, string>> = {};
  if (typeof obj.llm === "string" && obj.llm !== "") next.llm = obj.llm;
  if (typeof obj.asr === "string" && obj.asr !== "") next.asr = obj.asr;
  s.values = next;
}

function persist(s: StoreImpl): void {
  if (!s.codec.available()) throw new Error("系统密钥存储不可用，请用环境变量配置密钥");
  const body: { version: 1; llm?: string; asr?: string } = { version: 1 };
  if (s.values.llm !== undefined) body.llm = s.values.llm;
  if (s.values.asr !== undefined) body.asr = s.values.asr;
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
      for (const id of ["llm", "asr"] as const) {
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
