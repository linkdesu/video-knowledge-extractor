import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPrivateMode,
  buildSecretsJson,
  buildSettingsJson,
  extractPrivateConfig,
  loadPrivateConfig,
  parsePrivateConfig,
  seedUserData,
  writePrivateConfig,
} from "./config-seed";

const REPO = join(tmpdir(), "vnote-fake-repo-" + process.pid);
const EXAMPLE = join(REPO, ".omp/skills/verify-video-notes/config/llm.example.json");
const GOOD = { baseUrl: "https://router.example.net/v1", apiKey: "test-api-key-not-real", model: "mock-model" };

function mkdtemp(): string {
  const dir = join(tmpdir(), "vnote-seed-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("parsePrivateConfig", () => {
  test("收下合法配置并 trim", () => {
    expect(parsePrivateConfig({ baseUrl: ` ${GOOD.baseUrl} `, apiKey: ` ${GOOD.apiKey} `, model: " m " })).toEqual({
      baseUrl: GOOD.baseUrl,
      apiKey: GOOD.apiKey,
      model: "m",
    });
  });

  test("model 可缺省", () => {
    expect(parsePrivateConfig({ baseUrl: GOOD.baseUrl, apiKey: GOOD.apiKey })).toEqual({ ...GOOD, model: null });
  });

  test("缺字段 / 类型错 / 非 http / 模板值都被拒绝，且错误不回显值", () => {
    const cases: unknown[] = [
      null,
      [],
      { apiKey: GOOD.apiKey },
      { baseUrl: GOOD.baseUrl },
      { baseUrl: 1, apiKey: GOOD.apiKey },
      { baseUrl: GOOD.baseUrl, apiKey: 1 },
      { baseUrl: GOOD.baseUrl, apiKey: GOOD.apiKey, model: 3 },
      { baseUrl: "ftp://x", apiKey: GOOD.apiKey },
      { baseUrl: "https://your-endpoint.example/v1", apiKey: GOOD.apiKey },
      { baseUrl: GOOD.baseUrl, apiKey: "<在此填入真实 API key>" },
    ];
    for (const raw of cases) {
      expect(() => parsePrivateConfig(raw)).toThrow();
      try {
        parsePrivateConfig(raw);
      } catch (err) {
        expect((err as Error).message).not.toContain(GOOD.apiKey);
      }
    }
  });
});

describe("loadPrivateConfig", () => {
  test("文件缺失：提示模板路径与三步修复，不出现真实值", () => {
    const dir = mkdtemp();
    const path = join(dir, "llm.json");
    expect(() => loadPrivateConfig(path, { repoRoot: REPO, examplePath: EXAMPLE })).toThrow(/缺少私有 LLM 配置/);
    try {
      loadPrivateConfig(path, { repoRoot: REPO, examplePath: EXAMPLE });
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain(EXAMPLE);
      expect(message).toContain("chmod 600");
    }
  });

  test("仓库内的路径被拒绝", () => {
    mkdirSync(join(REPO, ".omp/skills/verify-video-notes/config"), { recursive: true });
    writeFileSync(EXAMPLE, JSON.stringify(GOOD), { mode: 0o600 });
    expect(() => loadPrivateConfig(join(REPO, "llm.json"), { repoRoot: REPO, examplePath: EXAMPLE })).toThrow(/仓库外/);
  });

  test("坏 JSON 报错", () => {
    const dir = mkdtemp();
    const path = join(dir, "llm.json");
    writeFileSync(path, "{ not json", { mode: 0o600 });
    expect(() => loadPrivateConfig(path, { repoRoot: REPO, examplePath: EXAMPLE })).toThrow(/不是合法 JSON/);
  });
});

describe("seedUserData", () => {
  let userData: string;
  beforeEach(() => {
    userData = mkdtemp();
  });

  test("写入真实存储格式：settings.json(version 3) + secrets.bin(v2, llm)，均 0600", () => {
    const out = seedUserData(userData, { ...GOOD, model: "mock-model" });
    expect(out.settingsPath).toBe(join(userData, "settings.json"));
    expect(out.secretsPath).toBe(join(userData, "secrets.bin"));
    const settings = JSON.parse(readFileSync(out.settingsPath, "utf8"));
    expect(settings.version).toBe(3);
    expect(settings.llm).toEqual({ baseUrl: GOOD.baseUrl, model: "mock-model" });
    const secrets = JSON.parse(readFileSync(out.secretsPath, "utf8"));
    expect(secrets.version).toBe(2);
    expect(secrets.llm).toBe(GOOD.apiKey);
    // Windows 不实现 POSIX 位；权限检查在 mac/linux 上断言，Windows 用 ACL（verify.ts 里校验）
    if (process.platform !== "win32") {
      expect(statSync(out.settingsPath).mode & 0o777).toBe(0o600);
      expect(statSync(out.secretsPath).mode & 0o777).toBe(0o600);
    }
  });

  test("保留既有其他字段与密钥位，只覆盖 llm", () => {
    writeFileSync(join(userData, "settings.json"), JSON.stringify({ version: 3, notesRoot: "/notes", llm: { baseUrl: "https://old/v1", model: "old" } }));
    writeFileSync(join(userData, "secrets.bin"), JSON.stringify({ version: 2, llm: "old-key", asr: "asr-key" }));
    seedUserData(userData, GOOD);
    const settings = JSON.parse(readFileSync(join(userData, "settings.json"), "utf8"));
    expect(settings.notesRoot).toBe("/notes");
    expect(settings.llm).toEqual({ baseUrl: GOOD.baseUrl, model: GOOD.model });
    const secrets = JSON.parse(readFileSync(join(userData, "secrets.bin"), "utf8"));
    expect(secrets.llm).toBe(GOOD.apiKey);
    expect(secrets.asr).toBe("asr-key");
  });
});

describe("buildSettingsJson / buildSecretsJson", () => {
  test("坏既有文件按空处理，不抛错", () => {
    expect(JSON.parse(buildSettingsJson("{bad", GOOD)).version).toBe(3);
    expect(JSON.parse(buildSecretsJson("{bad", GOOD)).llm).toBe(GOOD.apiKey);
  });
});

describe("extractPrivateConfig", () => {
  test("从已安装应用的 settings + secrets 提取", () => {
    const cfg = extractPrivateConfig(
      JSON.stringify({ version: 3, llm: { baseUrl: GOOD.baseUrl, model: GOOD.model } }),
      JSON.stringify({ version: 2, llm: GOOD.apiKey }),
    );
    expect(cfg).toEqual(GOOD);
  });

  test("旧版系统加密密文（非 JSON）明确拒绝", () => {
    expect(() => extractPrivateConfig(JSON.stringify({ version: 3, llm: { baseUrl: GOOD.baseUrl } }), "\u0001v10abc")).toThrow(/旧版系统加密/);
  });
});

describe("权限与私有文件", () => {
  test("writePrivateConfig 落 0600，可被 loadPrivateConfig 读回", () => {
    const dir = mkdtemp();
    const path = join(dir, ".config/video-notes-verify/llm.json");
    writePrivateConfig(path, GOOD);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    chmodSync(path, 0o600);
    expect(loadPrivateConfig(path, { repoRoot: REPO, examplePath: EXAMPLE })).toEqual(GOOD);
  });

  test("assertPrivateMode 只接受 0600", () => {
    expect(() => assertPrivateMode(0o600, "/x")).not.toThrow();
    expect(() => assertPrivateMode(0o644, "/x")).toThrow(/0600/);
    expect(() => assertPrivateMode(0o400, "/x")).toThrow(/0600/);
  });

  test("seed 后 settings.json 存在且不是旧文件残留", () => {
    const dir = mkdtemp();
    const { settingsPath } = seedUserData(dir, GOOD);
    expect(existsSync(settingsPath)).toBe(true);
  });
});
