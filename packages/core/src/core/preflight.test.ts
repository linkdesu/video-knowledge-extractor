import { describe, expect, test } from "bun:test";
import { formatPrerequisiteError, prerequisiteProblems, type PrerequisiteInput } from "./preflight";

function clear(): PrerequisiteInput {
  return { llmError: null, asrError: null, localModel: null, queueBusy: false };
}

describe("prerequisiteProblems", () => {
  test("全部就绪返回空数组", () => {
    expect(prerequisiteProblems(clear())).toEqual([]);
  });

  test("localModel 为 null（远程提供方）时忽略", () => {
    expect(prerequisiteProblems({ ...clear(), localModel: null, asrError: "ASR 未配齐：API key" })).toEqual([
      "ASR 未配齐：API key",
    ]);
  });

  test("队列忙单独一项", () => {
    expect(prerequisiteProblems({ ...clear(), queueBusy: true })).toEqual(["处理队列忙，请等待当前任务完成"]);
  });

  test("本地模型未就绪点名缺失的 bundle，就绪时跳过", () => {
    expect(prerequisiteProblems({ ...clear(), localModel: { ready: false, missing: ["识别", "标点"] } })).toEqual([
      "本地 ASR 模型未就绪：识别、标点",
    ]);
    expect(prerequisiteProblems({ ...clear(), localModel: { ready: true, missing: [] } })).toEqual([]);
  });
});

describe("formatPrerequisiteError", () => {
  test("空列表返回空字符串", () => {
    expect(formatPrerequisiteError([])).toBe("");
  });

  test("LLM 与本地模型同时缺失：一条消息按顺序列出全部", () => {
    const problems = prerequisiteProblems({
      ...clear(),
      llmError: "LLM 未配齐：接口地址、API key",
      localModel: { ready: false, missing: ["识别", "标点"] },
    });
    expect(problems).toEqual(["LLM 未配齐：接口地址、API key", "本地 ASR 模型未就绪：识别、标点"]);
    expect(formatPrerequisiteError(problems)).toBe(
      "开始处理前请先补齐以下配置：\n- LLM 未配齐：接口地址、API key\n- 本地 ASR 模型未就绪：识别、标点",
    );
  });
});
