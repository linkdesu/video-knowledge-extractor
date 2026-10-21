import { afterAll, describe, expect, test } from "bun:test";
import { llmCredentialsFromEnv, modelDir, notesRoot } from "./config";

const saved: Record<string, string | undefined> = {};
function withEnv(partial: Record<string, string | undefined>, fn: () => void): void {
  const keys = Object.keys(partial);
  for (const key of keys) saved[key] = process.env[key];
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
