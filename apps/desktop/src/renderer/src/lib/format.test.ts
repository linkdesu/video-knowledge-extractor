import { describe, expect, test } from "bun:test";
import { errMessage } from "./format";

describe("errMessage", () => {
  test("剥离 Electron IPC 包裹：只留正文", () => {
    const err = new Error(
      "Error invoking remote method 'extract:start': Error: 开始处理前请先补齐以下配置",
    );
    expect(errMessage(err)).toBe("开始处理前请先补齐以下配置");
  });

  test("包裹的字符串入参同样剥离", () => {
    expect(
      errMessage("Error invoking remote method 'a:b': Error: 目录不存在"),
    ).toBe("目录不存在");
  });

  test("嵌套双层包裹：逐层剥到正文", () => {
    const err = new Error(
      "Error invoking remote method 'outer': Error: Error invoking remote method 'inner': Error: 正文在这里",
    );
    expect(errMessage(err)).toBe("正文在这里");
  });

  test("纯正文原样返回", () => {
    expect(errMessage(new Error("开始处理前请先补齐以下配置"))).toBe(
      "开始处理前请先补齐以下配置",
    );
  });

  test("剥到空串时回退 String(err)", () => {
    expect(errMessage(new Error("Error:"))).toBe("Error:");
  });
});
