import { describe, expect, test } from "bun:test";
import { run, killActiveChildren, summarizeFfmpegArgs } from "./exec";
import { configureLogging, homePathPrefixes, redactHomePaths } from "./logger";

// 用 process.execPath 跑 -e 脚本，Windows 上也能跑
const NODE = process.execPath;
// 日志会把 home 前缀换成 ~（r46），Windows 的 execPath 在 USERPROFILE 下，断言要用脱敏后的形态
const LOGGED_NODE = redactHomePaths(NODE, homePathPrefixes());

describe("summarizeFfmpegArgs", () => {
  test("remux：-c copy 记 copy，output 取最后一个非选项参数", () => {
    expect(summarizeFfmpegArgs(["-y", "-i", "/in/a.mp4", "-c", "copy", "/out/a.mp4"])).toEqual({
      input: "/in/a.mp4",
      output: "/out/a.mp4",
      mode: "copy",
      videoCodec: null,
      audioCodec: null,
    });
    // 按流的 copy 也算 copy
    expect(summarizeFfmpegArgs(["-i", "/in/a.mkv", "-c:v", "copy", "-c:a", "copy", "/out/a.mp4"]).mode).toBe("copy");
    expect(summarizeFfmpegArgs(["-i", "/in/a.mkv", "-vcodec", "copy", "-acodec", "copy", "/out/a.mp4"]).mode).toBe("copy");
  });

  test("mp4 转码：videoCodec/audioCodec 取自 -c:v / -c:a", () => {
    const args = [
      "-y", "-i", "/in/a.mkv",
      "-map", "0:v:0", "-map", "0:a:0",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart", "-f", "mp4", "/out/a.mp4",
    ];
    expect(summarizeFfmpegArgs(args)).toEqual({
      input: "/in/a.mkv",
      output: "/out/a.mp4",
      mode: "transcode",
      videoCodec: "libx264",
      audioCodec: "aac",
    });
  });

  test("mp3 转码：只有音频编码器，videoCodec 为 null", () => {
    expect(summarizeFfmpegArgs(["-y", "-i", "/in/a.mp4", "-vn", "-map", "0:a:0", "-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3", "/out/a.mp3"])).toEqual({
      input: "/in/a.mp4",
      output: "/out/a.mp3",
      mode: "transcode",
      videoCodec: null,
      audioCodec: "libmp3lame",
    });
  });

  test("封面帧：两种 seek 顺序都拿到输入与 part 输出（尾随 -q:v 2 不被当输出）", () => {
    const before = ["-y", "-ss", "1.5", "-i", "/in/a.ts", "-map", "0:v:0", "-frames:v", "1", "-q:v", "2", "-vf", "scale='min(1280,iw)':-2", "/out/part.jpg"];
    const after = ["-y", "-i", "/in/a.ts", "-ss", "1.5", "-map", "0:v:0", "-frames:v", "1", "-q:v", "2", "-vf", "scale='min(1280,iw)':-2", "/out/part.jpg"];
    for (const args of [before, after]) {
      const summary = summarizeFfmpegArgs(args);
      expect(summary.input).toBe("/in/a.ts");
      expect(summary.output).toBe("/out/part.jpg");
      expect(summary.mode).toBe("transcode");
    }
  });

  test("尾部值是已知取值选项时被跳过，继续向前找", () => {
    expect(summarizeFfmpegArgs(["-i", "/in/a.mp4", "-frames:v", "1"]).output).toBe("/in/a.mp4");
    expect(summarizeFfmpegArgs(["-i", "/in/a.mp4", "-ss", "2.5"]).output).toBe("/in/a.mp4");
  });

  test("无 -i（ffprobe 形态）：input 为 null", () => {
    expect(summarizeFfmpegArgs(["-v", "error", "-show_entries", "format=duration", "-of", "json", "/in/a.mp4"])).toEqual({
      input: null,
      output: "/in/a.mp4",
      mode: "transcode",
      videoCodec: null,
      audioCodec: null,
    });
  });

  test("空 argv：全 null，默认 transcode", () => {
    expect(summarizeFfmpegArgs([])).toEqual({
      input: null,
      output: null,
      mode: "transcode",
      videoCodec: null,
      audioCodec: null,
    });
  });

  test("-i 后没有值时 input 为 null", () => {
    expect(summarizeFfmpegArgs(["-y", "-i"]).input).toBeNull();
  });
});

describe("run", () => {
  test("命令不存在（ENOENT）报错，消息含 label 与命令名", async () => {
    await expect(run(["definitely-not-a-real-cmd-xyz"], { label: "测试命令" })).rejects.toThrow("测试命令");
    await expect(run(["definitely-not-a-real-cmd-xyz"], { label: "测试命令" })).rejects.toThrow("definitely-not-a-real-cmd-xyz");
  });

  test("命令启动失败也写 ERROR 行：诊断能看出是「起不来」而不是「跑失败」", async () => {
    // r62 / #79：spawn 失败时 run() 只 reject，不写任何日志行，诊断文本里看不出原因
    // （高负载下进程创建瞬时失败会让只断言「命令失败」行的用例静默落空）
    const lines: string[] = [];
    configureLogging({ sink: (s) => lines.push(s) });
    const err = await run(["definitely-not-a-real-cmd-xyz"], { label: "测试命令" }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    // 抛错消息保持不变
    expect(err!.message).toContain("测试命令");
    const errLine = lines.find((l) => l.includes("ERROR") && l.includes(" ffmpeg ") && l.includes("命令启动失败")) ?? "";
    expect(errLine).toContain("definitely-not-a-real-cmd-xyz");
    // 失败原因（ENOENT 等）必须落在日志里，否则只能看到「启动失败」四个字
    expect(errLine).toContain("ENOENT");
    // 起不来时不该伪造「命令失败」行（那是 exit code 语义）
    expect(lines.some((l) => l.includes("命令失败"))).toBe(false);
  });

  test("非零退出默认抛错，消息含 stderr 尾部最后 12 行", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => "stderr-line-" + i);
    const script = lines.map((l) => `process.stderr.write('${l}\\n')`).join("; ");
    const err = await run([NODE, "-e", `${script}; process.exit(3)`], { label: "失败命令" }).then(() => undefined).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("失败命令");
    expect(err!.message).toContain("exit 3");
    for (const line of lines.slice(-12)) {
      expect(err!.message).toContain(line);
    }
    expect(err!.message).not.toContain(lines[0]);
  });

  test("allowFail 时返回 code 不抛", async () => {
    const result = await run([NODE, "-e", "console.log('hi'); process.exit(7)"], { label: "允许失败", allowFail: true });
    expect(result.code).toBe(7);
    expect(result.stdout).toContain("hi");
  });

  test("killActiveChildren 杀掉等待中的命令，以非零结束", async () => {
    // 真实定时器例外：长 setTimeout 只是让子进程存活到被 SIGKILL，等待的是 close 事件而非固定时长
    // run 内 activeChildren.add 在首个 await 前同步执行，spawn 后即可杀
    const pending = run([NODE, "-e", "setTimeout(() => {}, 5000)"], { label: "等待中的命令" });
    killActiveChildren();
    const err = await pending.then(() => undefined).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("等待中的命令");
  });

  test("sink 收到含命令名、退出码与 50 行 stderr 尾部的日志", async () => {
    const lines: string[] = [];
    configureLogging({ sink: (s) => lines.push(s) });
    // 30 行 stderr 都在 50 行尾部内，首尾都应出现在日志里
    const stderrScript = Array.from({ length: 30 }, (_, i) => `process.stderr.write('sline-${i}\\n')`).join("; ");
    await run([NODE, "-e", `${stderrScript}; process.exit(3)`], { label: "日志失败", allowFail: true });
    const cmdLine = lines.find((l) => l.includes("INFO") && l.includes("cmd=")) ?? "";
    expect(cmdLine).toContain(LOGGED_NODE);
    const errLine = lines.find((l) => l.includes("ERROR") && l.includes("命令失败")) ?? "";
    expect(errLine).toContain("code=3");
    expect(errLine).toContain("stderrTail=");
    expect(errLine).toContain("sline-0");
    expect(errLine).toContain("sline-29");
  });

  test("ffmpeg 模块额外记录且仅记录一行「命令摘要」，整条 argv 行保持原样", async () => {
    const lines: string[] = [];
    configureLogging({ sink: (s) => lines.push(s) });
    await run([NODE, "--version"], { label: "版本命令" });
    const summaries = lines.filter((l) => l.includes("命令摘要"));
    expect(summaries).toHaveLength(1);
    const summary = summaries[0]!;
    expect(summary).toContain("input=null");
    expect(summary).toContain("output=null");
    expect(summary).toContain('mode="transcode"');
    expect(summary).toContain("videoCodec=null");
    expect(summary).toContain("audioCodec=null");
    expect(summary).toContain('label="版本命令"');
    // 原有整条 argv 行不受影响
    const cmdLine = lines.find((l) => l.includes("cmd=")) ?? "";
    expect(cmdLine).toContain(LOGGED_NODE);
    expect(cmdLine).not.toContain("命令摘要");
  });

  test("非 ffmpeg 模块不写「命令摘要」行", async () => {
    const lines: string[] = [];
    configureLogging({ sink: (s) => lines.push(s) });
    await run([NODE, "--version"], { label: "版本命令", logModule: "app" });
    expect(lines.filter((l) => l.includes("命令摘要"))).toHaveLength(0);
  });
});
