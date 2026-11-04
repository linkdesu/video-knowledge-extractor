#!/usr/bin/env bun
/**
 * r76c 真实端点语料验证（手动运行，不进默认测试、不 mock）：
 *
 * 用应用自己的配置加载方式取端点——`<userData>/settings.json`（`readSettingsFileSafe` + `resolveSettings`）
 * 与 `<userData>/secrets.bin`（应用的 `createSecretStore`，同一 codec 边界），再走 `resolveLlm`
 * + `resolveLlmEndpoint`，与打包版启动时同一条路径。**不读 .env、不打印 secrets.bin 内容或任何 key。**
 *
 * 两次请求、各一批，跑 `filterFillerUtterances`（规则 + 模型，就是真实管线里的那个入口）：
 * 1. `fixtures/filler-must-keep.json`：r76b QA 稳定误删的 16 条必须保留行 → 期望 0 丢弃；
 * 2. `fixtures/filler-noise-109.json`：#109 点名的三行噪声 → 期望全部丢弃（返工不能把要删的留下）。
 *
 * 用法：`bun run apps/cli/src/verify-filler-corpus.ts --out tmp/verify/r76c-filler-rework`
 * 任一条不符期望即 exit 1。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { configureLogging } from "../../../packages/core/src/core/logger";
import { readSettingsFileSafe, resolveSettings } from "../../../packages/core/src/core/settings";
import { resolveLlm } from "../../../packages/core/src/core/credentials";
import { resolveLlmEndpoint } from "../../../packages/core/src/llm/endpoint";
import { filterFillerUtterances } from "../../../packages/core/src/pipeline/filler-filter";
import { createSecretStore, plainFileCodec } from "../../desktop/src/main/secrets";

type CorpusRow = { start: number; end: number; speaker: string; text: string; why?: string };

/** Electron 的 userData 默认位置：打包版按 productName 落在 `Video Notes`，旧构建是 `@video-notes`。 */
function defaultUserData(): string {
  if (process.env.VNOTE_USER_DATA !== undefined && process.env.VNOTE_USER_DATA !== "") return resolve(process.env.VNOTE_USER_DATA);
  const base = platform() === "win32" ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")) : join(homedir(), "Library", "Application Support");
  const candidates = ["Video Notes", "@video-notes"].map((name) => join(base, name));
  return candidates.find((dir) => existsSync(join(dir, "settings.json"))) ?? candidates[0]!;
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadCorpus(name: string): CorpusRow[] {
  return (JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "packages", "core", "src", "pipeline", "fixtures", name), "utf8")) as { rows: CorpusRow[] }).rows;
}

async function main(): Promise<void> {
  const outDir = resolve(argValue("--out") ?? join(import.meta.dir, "..", "..", "..", "tmp", "verify", "r76c-filler-rework"));
  const userData = defaultUserData();
  const logLines: string[] = [];
  const log = configureLogging({ level: "info", console: false, sink: (l) => logLines.push(l) });

  const settingsRead = readSettingsFileSafe(join(userData, "settings.json"));
  if (settingsRead.error !== null) {
    console.log(`settings.json 读取失败（已隔离到 ${settingsRead.quarantinedPath ?? "无"}）：${settingsRead.error}`);
    process.exit(2);
  }
  // 打包版不加载 .env：这里传入空 env，避免把开发机 shell 里的 VNOTE_* 混进求值
  const { settings } = resolveSettings(settingsRead.file, {});
  const store = createSecretStore({ file: join(userData, "secrets.bin"), codec: plainFileCodec });
  const resolved = resolveLlm(settings, store.get("llm"));
  if (resolved.value === undefined) {
    console.log(`LLM 未配置完整（缺：${resolved.missing.join("、")}），跳过验证。`);
    process.exit(2);
  }
  const endpoint = await resolveLlmEndpoint(resolved.value);
  log.addSecret(endpoint.apiKey);

  const mustKeep = loadCorpus("filler-must-keep.json");
  const noise = loadCorpus("filler-noise-109.json");
  const startedAt = new Date().toISOString();

  const keepResult = await filterFillerUtterances({ rows: mustKeep, endpoint });
  const noiseResult = await filterFillerUtterances({ rows: noise, endpoint });

  const keptTexts = new Set(keepResult.rows.map((r) => r.text));
  const droppedMustKeep = mustKeep.filter((r) => !keptTexts.has(r.text));
  const noiseLeft = noiseResult.rows.map((r) => r.text);

  mkdirSync(outDir, { recursive: true });
  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    userData,
    llm: { baseUrl: endpoint.baseUrl, model: endpoint.model, keySource: resolved.keySource },
    mustKeep: {
      rows: mustKeep.length,
      droppedByRules: keepResult.droppedByRules,
      droppedByLlm: keepResult.droppedByLlm,
      candidates: keepResult.batches.reduce((n, b) => n + b.size, 0),
      batches: keepResult.batches,
      dropped: droppedMustKeep.map((r) => ({ start: r.start, speaker: r.speaker, text: r.text })),
      pass: droppedMustKeep.length === 0,
    },
    noise109: {
      rows: noise.length,
      droppedByRules: noiseResult.droppedByRules,
      droppedByLlm: noiseResult.droppedByLlm,
      batches: noiseResult.batches,
      kept: noiseLeft,
      pass: noiseLeft.length === 0,
    },
  };
  writeFileSync(join(outDir, "real-llm-corpus.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, "real-llm-corpus.log.txt"), `${logLines.join("\n")}\n`);

  console.log(`端点：${endpoint.baseUrl}（model=${endpoint.model}，keySource=${resolved.keySource}，key 不打印）`);
  console.log(`必须保留语料：${mustKeep.length} 条，候选 ${report.mustKeep.candidates} 条，droppedByLlm=${keepResult.droppedByLlm} → ${droppedMustKeep.length === 0 ? "PASS" : "FAIL"}`);
  for (const row of droppedMustKeep) console.log(`  误删：${row.start.toFixed(2)}s ${row.text}`);
  console.log(`#109 噪声：${noise.length} 条，droppedByLlm=${noiseResult.droppedByLlm} → ${noiseLeft.length === 0 ? "PASS" : "FAIL"}`);
  for (const text of noiseLeft) console.log(`  未删：${text}`);
  console.log(`证据：${join(outDir, "real-llm-corpus.json")}`);
  if (droppedMustKeep.length > 0 || noiseLeft.length > 0) process.exit(1);
}

await main();
