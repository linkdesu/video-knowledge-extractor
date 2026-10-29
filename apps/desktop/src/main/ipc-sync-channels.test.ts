import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * r49 防回归：preload 在页面加载前用 `ipcRenderer.sendSync` 询问通道，而 `sendSync` 在
 * 主进程没有监听者时**不抛错、而是阻塞 renderer 主线程约 30 秒**（打包版首启白屏的根因）。
 * 所以每个 sendSync 通道都必须在主进程有一个不依赖开发模式的 `ipcMain.on` 注册。
 */
const SRC = join(import.meta.dirname, "..");
const MAIN_INDEX = join(SRC, "main/index.ts");

/** shared 里 `export const X = { key: "channel" } as const` → `{ "X.key": "channel" }`。 */
function channelMap(file: string, constName: string): Map<string, string> {
  const source = readFileSync(join(SRC, "shared", file), "utf8");
  const start = source.indexOf(`export const ${constName} = {`);
  if (start < 0) throw new Error(`${file}: 找不到 export const ${constName}`);
  const end = source.indexOf("} as const;", start);
  if (end < 0) throw new Error(`${file}: ${constName} 不是 as const 对象`);
  const map = new Map<string, string>();
  for (const match of source.slice(start, end).matchAll(/(\w+):\s*"([^"]+)"/g)) {
    const key = match[1];
    const channel = match[2];
    if (key === undefined || channel === undefined) continue;
    map.set(`${constName}.${key}`, channel);
  }
  return map;
}

const CHANNELS = new Map([...channelMap("ipc.ts", "IPC"), ...channelMap("lab.ts", "LAB_IPC")]);

/** `IPC.foo` / `LAB_IPC.foo` / 字符串字面量 → 真实通道名。 */
function resolveChannel(expression: string): string | null {
  const literal = /^["']([^"']+)["']$/.exec(expression.trim());
  const name = literal?.[1];
  if (name !== undefined) return name;
  return CHANNELS.get(expression.trim()) ?? null;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

/** preload 里所有 `sendSync(<expr>` 解析出的通道；解析不了的直接失败，不许跳过。 */
function preloadSyncChannels(): string[] {
  const source = readFileSync(join(SRC, "preload/index.ts"), "utf8");
  const found: string[] = [];
  for (const match of source.matchAll(/sendSync\(\s*([^,)]+)/g)) {
    const expression = match[1];
    if (expression === undefined) continue;
    const channel = resolveChannel(expression);
    if (channel === null) throw new Error(`preload: 无法解析 sendSync 通道表达式 ${expression}`);
    found.push(channel);
  }
  return found;
}

/** 主进程（**不含** dev-lab/）里所有 `ipcMain.on(<expr>,` 注册的通道。 */
function mainSyncChannels(): Set<string> {
  const registered = new Set<string>();
  const mainDir = join(SRC, "main");
  for (const file of sourceFiles(mainDir).filter((f) => !f.includes(`${join("main", "dev-lab")}/`))) {
    for (const match of readFileSync(file, "utf8").matchAll(/ipcMain\.on\(\s*([^,]+),/g)) {
      const expression = match[1];
      if (expression === undefined) continue;
      const channel = resolveChannel(expression);
      if (channel !== null) registered.add(channel);
    }
  }
  return registered;
}

describe("preload sendSync 通道", () => {
  test("每个通道都有主进程同步处理器（缺一个就会让 renderer 主线程阻塞约 30 秒）", () => {
    const syncChannels = preloadSyncChannels();
    expect(syncChannels.length).toBeGreaterThan(0);
    const registered = mainSyncChannels();
    const missing = syncChannels.filter((channel) => !registered.has(channel));
    expect(missing).toEqual([]);
  });

  test("dev-lab 不再注册 sendSync 通道，避免与主进程双监听", () => {
    const source = readFileSync(join(SRC, "main/dev-lab/register.ts"), "utf8");
    expect(source.includes("ipcMain.on(")).toBe(false);
  });

  test("Lab 可用性通道的注册不在 labRoot 门禁里（打包版也要应答 false）", () => {
    const source = readFileSync(MAIN_INDEX, "utf8");
    const registration = source.indexOf("ipcMain.on(LAB_IPC.available");
    expect(registration).toBeGreaterThan(-1);
    const gate = source.indexOf("if (labRoot !== undefined)");
    expect(gate).toBeGreaterThan(-1);
    expect(registration).toBeLessThan(gate);
  });
});
