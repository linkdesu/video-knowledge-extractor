import { DashScopeAdapter } from "../src/asr/dashscope";

const result = {
  transcripts: [
    {
      channel_id: 0,
      text: "你好，欢迎。",
      sentences: [
        { begin_time: 0, end_time: 2400, text: "你好，", speaker_id: 0 },
        { begin_time: 2400, end_time: 5100, text: "欢迎。", speaker_id: 1 },
      ],
    },
  ],
};

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/v1/services/audio/asr/transcription") {
      return Response.json({ output: { task_id: "t1", task_status: "PENDING" } });
    }
    if (url.pathname === "/api/v1/tasks/t1") {
      return Response.json({
        output: { task_status: "SUCCEEDED", results: [{ transcription_url: `http://127.0.0.1:${server.port}/result.json` }] },
      });
    }
    if (url.pathname === "/result.json") return Response.json(result);
    return new Response("not found", { status: 404 });
  },
});

const adapter = new DashScopeAdapter({
  apiKey: "test",
  baseUrl: `http://127.0.0.1:${server.port}`,
  fileUrl: "oss://mock/audio.wav",
  pollIntervalMs: 10,
});
const run = await adapter.transcribe("unused.wav");
server.stop(true);

const expected = [
  { start: 0, end: 2.4, speaker: "S1", text: "你好，" },
  { start: 2.4, end: 5.1, speaker: "S2", text: "欢迎。" },
];
if (JSON.stringify(run.utterances) !== JSON.stringify(expected)) {
  console.error("FAIL", run.utterances);
  process.exit(1);
}
if (run.glossaryMode !== "none") {
  console.error("FAIL glossaryMode", run.glossaryMode);
  process.exit(1);
}
console.log("dashscope mock ok:", run.utterances.length, "utterances, timings", run.timings);
