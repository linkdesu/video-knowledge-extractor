import { describe, expect, test } from "bun:test";
import { describeFailure } from "./failure-summary";

describe("describeFailure", () => {
  test("已知原因映射成短词", () => {
    expect(describeFailure("切主题切片 failed (exit 234) / Stream map '' matches no streams")).toBe("该文件没有可用的音视频轨道");
    expect(describeFailure("ffmpeg: Stream map '' matches no streams")).toBe("该文件没有可用的音视频轨道");
    expect(describeFailure("[out#0/wav] Output file does not contain any stream")).toBe("该文件没有可用的音视频轨道");
    expect(describeFailure("LLM 请求失败 401 Unauthorized")).toBe("API key 无效");
    expect(describeFailure("ASR 返回 403 forbidden")).toBe("API key 无效");
    expect(describeFailure("API key 无效：key 已过期")).toBe("API key 无效");
    expect(describeFailure("本地 ASR 模型未就绪：缺少识别")).toBe("本地 ASR 模型未就绪");
    expect(describeFailure("模型未就绪")).toBe("本地 ASR 模型未就绪");
    expect(describeFailure("ffprobe 打不开该文件")).toBe("视频文件损坏");
    expect(describeFailure("moov atom not found")).toBe("视频文件损坏");
    expect(describeFailure("Invalid data found when processing input")).toBe("视频文件损坏");
    expect(describeFailure("decoder error on stream 0")).toBe("视频文件损坏");
    expect(describeFailure("未配置 LLM 端点")).toBe("LLM 未配置");
    expect(describeFailure("LLM 未配齐：接口地址")).toBe("LLM 未配置");
    expect(describeFailure("worker 进程退出（退出码 1）\nstack")).toBe("处理进程意外退出");
    expect(describeFailure("音轨无法解码（文件可能已损坏或来自加密直播录像），请重新导出为 mp4/m4a 后再导入")).toBe(
      "音轨无法解码，请重新导出为 mp4/m4a",
    );
  });

  test("未知消息取第一非空行", () => {
    expect(describeFailure("\n  第一段被截断  \n第二行")).toBe("第一段被截断");
    expect(describeFailure("处理失败：boom")).toBe("处理失败：boom");
  });

  test("超过 60 字符截断到 60", () => {
    expect(describeFailure("x".repeat(80))).toBe("x".repeat(60));
    expect(describeFailure("y".repeat(60))).toBe("y".repeat(60));
  });

  test("空消息给兜底短词", () => {
    expect(describeFailure("")).toBe("处理失败");
    expect(describeFailure("   \n  ")).toBe("处理失败");
  });
});
