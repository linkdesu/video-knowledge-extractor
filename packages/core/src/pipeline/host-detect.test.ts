import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { configureLogging } from "../core/logger";
import { detectHosts, heuristicHosts, speakerStats } from "./host-detect";
import type { SpeakerStat } from "./host-detect";
import type { ChatMessage, LlmClient, LlmEndpoint } from "../core/steps";
import type { Speaker, SpeakerId, Transcript, Utterance } from "../core/types";

const endpoint: LlmEndpoint = { baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-secret-test", model: "m-test" };

/** 每次用新的临时缓存目录：固定路径会让上一轮的文件变成命中，测试互相污染。 */
function tempCacheDir(): string {
  return mkdtempSync(`${tmpdir()}/host-detect-`);
}

const SPK1: Speaker = { id: "spk-1" as SpeakerId, name: "说话人1", color: "#f00" };
const SPK2: Speaker = { id: "spk-2" as SpeakerId, name: "说话人2", color: "#0f0" };
const SPK3: Speaker = { id: "spk-3" as SpeakerId, name: "说话人3", color: "#00f" };

function u(speaker: string, start: number, end: number, text: string): Utterance {
  return { speakerId: speaker as SpeakerId, start, end, text };
}

/** 超过 80 字，用来验证提示词里的示例发言被截断。 */
const LONG_ANSWER =
  "我一般先把素材按主题归类，再把关键句子摘出来并补上时间戳，这样回看的时候能直接跳过去，不用重新听一遍整段录音，" +
  "顺便把术语和专有名词统一一遍，最后再检查有没有漏掉的结论和行动项。";

/** 一个人提问三次、另一个人每次长答：问答轮只属于被问的那个人。 */
const interview: Transcript = {
  speakers: [SPK1, SPK2],
  utterances: [
    u("spk-1", 0, 5, "今天想请你聊聊视频笔记，可以吗？"),
    u("spk-2", 5, 65, LONG_ANSWER),
    u("spk-1", 70, 75, "那你是怎么整理素材的呢？"),
    u("spk-2", 75, 135, LONG_ANSWER),
    u("spk-1", 140, 145, "最后一个问题，你觉得难点在哪？"),
    u("spk-2", 145, 205, LONG_ANSWER),
  ],
};

/** 两个主播轮流回答同一个提问者。 */
const duo: Transcript = {
  speakers: [SPK1, SPK2, SPK3],
  utterances: [
    u("spk-1", 0, 5, "第一个问题，两位怎么看？"),
    u("spk-2", 5, 45, LONG_ANSWER),
    u("spk-1", 45, 50, "那你呢？"),
    u("spk-3", 50, 90, LONG_ANSWER),
    u("spk-1", 90, 95, "再说说难点？"),
    u("spk-2", 95, 135, LONG_ANSWER),
    u("spk-1", 135, 140, "最后还有什么要补充？"),
    u("spk-3", 140, 180, LONG_ANSWER),
  ],
};

/** 独白：只有一个人在说，没有问答。 */
const monologue: Transcript = {
  speakers: [SPK1],
  utterances: [
    u("spk-1", 0, 10, "这期我们讲讲怎么做视频笔记。"),
    u("spk-1", 10, 20, "第一步是把长视频转成字幕行。"),
    u("spk-1", 20, 30, "第二步是在字幕行上划出主题。"),
    u("spk-1", 30, 40, "第三步是只给选中的主题生成笔记。"),
    u("spk-1", 40, 50, "这样一条视频就被拆成能读完的东西。"),
  ],
};

type Recorder = { client: LlmClient; calls: number; sent: ChatMessage[][] };

function recorder(reply: () => string): Recorder {
  const rec: Recorder = {
    calls: 0,
    sent: [],
    client: {
      model: endpoint.model,
      chat: async (messages) => {
        rec.calls += 1;
        rec.sent.push(messages);
        return reply();
      },
    },
  };
  return rec;
}

/** 品牌 id 在断言里按字符串比较：`toEqual` 的期望值不该到处写 `as SpeakerId`。 */
function expectHosts(hosts: readonly SpeakerId[], expected: string[]): void {
  expect(hosts.map((id) => String(id))).toEqual(expected);
}

function statOf(stats: SpeakerStat[], id: string) {
  const stat = stats.find((s) => s.id === id);
  if (stat === undefined) throw new Error(`没有统计：${id}`);
  return stat;
}

function totalSecondsOf(transcript: Transcript): number {
  return transcript.utterances.reduce((sum, x) => sum + (x.end - x.start), 0);
}

describe("speakerStats", () => {
  test("提问者被问三次、被问的人长答：回答轮与回答时长只算在被问的人头上", () => {
    const stats = speakerStats(interview);
    const host = statOf(stats, "spk-2");
    const interviewer = statOf(stats, "spk-1");
    expect(stats).toHaveLength(2);
    expect(host.answerTurns).toBe(3);
    expect(host.answerSeconds).toBe(180);
    expect(host.turns).toBe(3);
    expect(host.seconds).toBe(180);
    expect(interviewer.answerTurns).toBe(0);
    expect(interviewer.answerSeconds).toBe(0);
    expect(interviewer.turns).toBe(3);
    expect(host.answerSeconds).toBeGreaterThan(interviewer.answerSeconds);
  });

  test("合并掉的说话人折叠到存活者，不单独出现", () => {
    const transcript: Transcript = {
      speakers: [{ ...SPK2, mergedInto: SPK3.id }, SPK3],
      utterances: [u("spk-1", 0, 5, "你怎么看？"), u("spk-2", 5, 25, LONG_ANSWER)],
    };
    const stats = speakerStats(transcript);
    expectHosts(stats.map((s) => s.id), ["spk-3"]);
    expect(statOf(stats, "spk-3").turns).toBe(1);
    expect(statOf(stats, "spk-3").answerTurns).toBe(1);
  });
});

describe("heuristicHosts", () => {
  test("访谈里只有被问的那个人够格", () => {
    expectHosts(heuristicHosts(speakerStats(interview), totalSecondsOf(interview)), ["spk-2"]);
  });

  test("双主播脚本两个都选中", () => {
    const hosts = heuristicHosts(speakerStats(duo), totalSecondsOf(duo));
    expect(hosts).toHaveLength(2);
    expectHosts(hosts, ["spk-2", "spk-3"]);
  });

  test("独白里唯一的说话人就是主播", () => {
    expectHosts(heuristicHosts(speakerStats(monologue), totalSecondsOf(monologue)), ["spk-1"]);
  });

  test("没有任何统计时返回空", () => {
    expectHosts(heuristicHosts([], 0), []);
  });
});

describe("detectHosts", () => {
  test("模型给出的 id 被接受，来源记 auto", async () => {
    const rec = recorder(() => JSON.stringify({ hosts: ["spk-2"] }));
    const result = await detectHosts({ transcript: interview, endpoint, cacheDir: tempCacheDir(), client: rec.client });
    expectHosts(result.hosts, ["spk-2"]);
    expect(result.source).toBe("auto");
    expect(rec.calls).toBe(1);
    // 提示词里带说话人统计与示例发言，示例发言被截断到 80 字
    const system = rec.sent[0]?.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("id=spk-2");
    expect(system).toContain("占比 92%");
    expect(system).toContain("…");
    expect(system).not.toContain(LONG_ANSWER);
  });

  test("模型返回对象数组也接受", async () => {
    const rec = recorder(() => JSON.stringify({ hosts: [{ id: "spk-2" }] }));
    const result = await detectHosts({ transcript: interview, endpoint, cacheDir: tempCacheDir(), client: rec.client });
    expectHosts(result.hosts, ["spk-2"]);
    expect(result.source).toBe("auto");
  });

  test("模型编造不存在的 id 时退回统计", async () => {
    const rec = recorder(() => JSON.stringify({ hosts: ["spk-999"] }));
    const result = await detectHosts({ transcript: interview, endpoint, cacheDir: tempCacheDir(), client: rec.client });
    expectHosts(result.hosts, ["spk-2"]);
    expect(result.source).toBe("heuristic");
  });

  test("模型抛错时退回统计，不把错误抛给调用方", async () => {
    const rec = recorder(() => {
      throw new Error("接口 502");
    });
    const result = await detectHosts({ transcript: interview, endpoint, cacheDir: tempCacheDir(), client: rec.client });
    expectHosts(result.hosts, ["spk-2"]);
    expect(result.source).toBe("heuristic");
  });

  test("模型返回坏 JSON 时退回统计", async () => {
    const rec = recorder(() => "我不知道");
    const result = await detectHosts({ transcript: interview, endpoint, cacheDir: tempCacheDir(), client: rec.client });
    expectHosts(result.hosts, ["spk-2"]);
    expect(result.source).toBe("heuristic");
  });

  test("缓存命中后第二次调用不再请求模型", async () => {
    const cacheDir = tempCacheDir();
    const rec = recorder(() => JSON.stringify({ hosts: ["spk-2"] }));
    const first = await detectHosts({ transcript: interview, endpoint, cacheDir, client: rec.client });
    const second = await detectHosts({ transcript: interview, endpoint, cacheDir, client: rec.client });
    expect(rec.calls).toBe(1);
    expect(second).toEqual(first);
  });

  test("日志只记结构化统计，不含提示词正文与密钥", async () => {
    const lines: string[] = [];
    configureLogging({ level: "info", sink: (l) => lines.push(l) });
    const rec = recorder(() => JSON.stringify({ hosts: ["spk-2"] }));
    await detectHosts({ transcript: interview, endpoint, cacheDir: tempCacheDir(), client: rec.client });
    const joined = lines.join("\n");
    expect(joined).toContain("主播识别完成");
    expect(joined).toContain("hostCount=1");
    expect(joined).toContain('source="auto"');
    expect(joined).toContain("cacheHit=false");
    expect(joined).not.toContain("你是播客转写分析器");
    expect(joined).not.toContain("sk-secret-test");
  });

  test("提示词版本 行带 promptId 与 64 位 sha，缓存命中时不再多一条", async () => {
    const lines: string[] = [];
    configureLogging({ level: "info", sink: (l) => lines.push(l) });
    const cacheDir = tempCacheDir();
    const rec = recorder(() => JSON.stringify({ hosts: ["spk-2"] }));
    await detectHosts({ transcript: interview, endpoint, cacheDir, client: rec.client });
    await detectHosts({ transcript: interview, endpoint, cacheDir, client: rec.client });
    expect(rec.calls).toBe(1);
    const requests = lines.filter((l) => l.includes("提示词版本"));
    expect(requests).toHaveLength(1);
    const line = requests[0]!;
    expect(line).toContain(" llm ");
    expect(line).toContain('promptId="host-detect"');
    expect(line).toContain('promptSource="default"');
    expect(line).toMatch(/promptSha256="[0-9a-f]{64}"/);
    expect(line).toContain('model="m-test"');
    expect(line).toContain('kind="host-detect"');
    expect(line).not.toContain("hosts=");
    expect(line).not.toContain("你是播客转写分析器");
    expect(line).not.toContain("sk-secret-test");
  });
});
