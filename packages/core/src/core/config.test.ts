import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asrEnv, envValue, llmEnv, llmCredentialsFromEnv, modelDir, notesRoot } from "./config";

beforeAll(() => {
  process.env.VNOTE_HOME = "/tmp/vnote-config-home";
  process.env.VNOTE_USER_DATA = "/tmp/vnote-config-data";
});

const saved: Record<string, string | undefined> = {};
function withEnv(partial: Record<string, string | undefined>, fn: () => void): void {
  const keys = Object.keys(partial);
  for (const [key, value] of Object.entries(partial)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("notesRoot", () => {
  test("VNOTE_HOME 优先，每次调用读 env", () => {
    const env: Record<string, string | undefined> = { VNOTE_HOME: "/a", HOME: "/h" };
    expect(notesRoot(env)).toBe("/a");
    env.VNOTE_HOME = "/b";
    expect(notesRoot(env)).toBe("/b");
  });

  test("VNOTE_HOME 缺失时回落到 HOME 下的默认目录", () => {
    expect(notesRoot({ HOME: "/h" })).toBe("/h/Documents/video-notes");
  });
});

describe("modelDir", () => {
  test("VNOTE_MODEL_DIR 优先，每次调用读 env", () => {
    const env: Record<string, string | undefined> = { VNOTE_MODEL_DIR: "/m", HOME: "/h" };
    expect(modelDir(env)).toBe("/m");
    env.VNOTE_MODEL_DIR = "/n";
    expect(modelDir(env)).toBe("/n");
  });

  test("VNOTE_MODEL_DIR 缺失时回落到 HOME 下的默认目录", () => {
    expect(modelDir({ HOME: "/h" })).toBe("/h/.cache/video-notes/models");
  });
});

describe("llmCredentialsFromEnv", () => {
  test("VNOTE_* 别名赢 IDEALSOFT_*", () => {
    const env: Record<string, string | undefined> = {
      VNOTE_LLM_BASE_URL: "https://vnote",
      IDEALSOFT_API_URL: "https://idealsoft",
      VNOTE_LLM_API_KEY: "k-test-a",
      IDEALSOFT_API_KEY: "k-test-b",
      VNOTE_LLM_MODEL: "m-test-a",
      IDEALSOFT_API_MODEL: "m-test-b",
    };
    expect(llmCredentialsFromEnv(env)).toEqual({ baseUrl: "https://vnote", apiKey: "k-test-a", model: "m-test-a" });
  });

  test("只有 IDEALSOFT_* 时也可用", () => {
    const env: Record<string, string | undefined> = {
      IDEALSOFT_API_URL: "https://idealsoft",
      IDEALSOFT_API_KEY: "k-test-b",
    };
    expect(llmCredentialsFromEnv(env)).toEqual({ baseUrl: "https://idealsoft", apiKey: "k-test-b" });
  });

  test("没有 model 也返回凭据", () => {
    const env: Record<string, string | undefined> = {
      VNOTE_LLM_BASE_URL: "https://vnote",
      VNOTE_LLM_API_KEY: "k-test-a",
    };
    expect(llmCredentialsFromEnv(env)).toEqual({ baseUrl: "https://vnote", apiKey: "k-test-a" });
  });

  test("base 或 key 缺失返回 undefined", () => {
    expect(llmCredentialsFromEnv({ VNOTE_LLM_BASE_URL: "https://vnote" })).toBeUndefined();
    expect(llmCredentialsFromEnv({ VNOTE_LLM_API_KEY: "k-test-a" })).toBeUndefined();
  });

  test("空串等同缺失", () => {
    const env: Record<string, string | undefined> = {
      VNOTE_LLM_BASE_URL: "  ",
      IDEALSOFT_API_URL: "https://idealsoft",
      VNOTE_LLM_API_KEY: "k-test-a",
    };
    expect(llmCredentialsFromEnv(env)).toEqual({ baseUrl: "https://idealsoft", apiKey: "k-test-a" });
  });

  test("默认参数读 process.env", () => {
    withEnv(
      { VNOTE_LLM_BASE_URL: "https://p", VNOTE_LLM_API_KEY: "k-test-p", VNOTE_LLM_MODEL: "m-test-p" },
      () => {
        expect(llmCredentialsFromEnv()).toEqual({ baseUrl: "https://p", apiKey: "k-test-p", model: "m-test-p" });
      },
    );
  });
});


describe("envValue", () => {
  test("规范名优先，trim，空串视为未设置", () => {
    const env = { A: "  value-a  ", B: "value-b" };
    expect(envValue(env, ["A", "B"])).toBe("value-a");
  });

  test("规范名是空白时回落到别名", () => {
    const env = { A: "   ", B: "value-b" };
    expect(envValue(env, ["A", "B"])).toBe("value-b");
  });

  test("全部空白或未设置返回 undefined", () => {
    expect(envValue({ A: "" }, ["A", "B"])).toBeUndefined();
    expect(envValue({}, ["A"])).toBeUndefined();
  });
});

describe("llmEnv 与 asrEnv", () => {
  test("llmEnv 按变量表取分字段值", () => {
    const env = {
      VNOTE_LLM_BASE_URL: "https://vnote",
      IDEALSOFT_API_KEY: "k-idealsoft",
      VNOTE_LLM_MODEL: "m-vnote",
    };
    expect(llmEnv(env)).toEqual({ baseUrl: "https://vnote", apiKey: "k-idealsoft", model: "m-vnote" });
  });

  test("未设置的字段是 undefined", () => {
    expect(llmEnv({})).toEqual({ baseUrl: undefined, apiKey: undefined, model: undefined });
  });

  test("asrEnv 按变量表取分字段值", () => {
    const env = {
      VNOTE_ASR_PROVIDER: "volcengine",
      VNOTE_ASR_BASE_URL: "https://asr",
      VNOTE_ASR_MODEL: "m-asr",
      VNOTE_ASR_API_KEY: "k-asr",
      VNOTE_VOLC_API_KEY: "k-volc",
      VNOTE_VOLC_APP_KEY: "k-app",
      VNOTE_VOLC_ACCESS_KEY: "k-access",
      VNOTE_ASR_VOLC_MODE: "standard",
      VNOTE_ASR_VOLC_AUTH_MODE: "appAccessKey",
    };
    expect(asrEnv(env)).toEqual({
      provider: "volcengine",
      baseUrl: "https://asr",
      model: "m-asr",
      apiKey: "k-asr",
      volcApiKey: "k-volc",
      volcAppKey: "k-app",
      volcAccessKey: "k-access",
      volcMode: "standard",
      volcAuthMode: "appAccessKey",
    });
  });

  test("旧 provider 值 remote 归一成 openai", () => {
    expect(asrEnv({ VNOTE_ASR_PROVIDER: "remote" }).provider).toBe("openai");
    expect(asrEnv({ VNOTE_ASR_PROVIDER: "openai" }).provider).toBe("openai");
  });

  test("VOLC_ASR_API_KEY 别名在 VNOTE_VOLC_API_KEY 缺失时生效", () => {
    expect(asrEnv({ VOLC_ASR_API_KEY: "alias" }).volcApiKey).toBe("alias");
    expect(asrEnv({}).volcApiKey).toBeUndefined();
  });

  test("VOLC_ASR_API_KEY 不覆盖已设置的 VNOTE_VOLC_API_KEY（规范名优先）", () => {
    expect(asrEnv({ VNOTE_VOLC_API_KEY: "canonical", VOLC_ASR_API_KEY: "alias" }).volcApiKey).toBe("canonical");
    expect(asrEnv({ VNOTE_VOLC_API_KEY: "  ", VOLC_ASR_API_KEY: "alias" }).volcApiKey).toBe("alias");
  });
});