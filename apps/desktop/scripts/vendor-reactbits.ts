/**
 * 把 reactbits.json 里的 React Bits Pro 条目落到 src/renderer/src/rbp/。
 * 走 shadcn registry 协议，license 只从环境变量或仓库根 .env 读取，不打印、不落盘到被跟踪文件。
 *
 * 只在新增条目时跑：rbp/ 下的文件已经按本项目改造过，重跑会用上游原文覆盖这些改动。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type RegistryItem = {
  name: string;
  type: string;
  files?: { path: string; content: string }[];
  dependencies?: string[];
  registryDependencies?: string[];
};

type Manifest = { items: { registry: "starter" | "pro"; name: string }[] };

const appRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appRoot, "../..");
const outRoot = join(appRoot, "src/renderer/src/rbp");
const BASE = "https://pro.reactbits.dev/api/r";

// app-ui-theme 只有 CSS 变量，已手工并入 renderer 的 styles.css。
const HANDLED_BY_REPO: Record<string, true> = { "@reactbits-pro/app-ui-theme": true };

function licenseKey(): string {
  const fromEnv = process.env.REACTBITS_LICENSE_KEY;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  let text: string;
  try {
    text = readFileSync(join(repoRoot, ".env"), "utf8");
  } catch {
    throw new Error("REACTBITS_LICENSE_KEY 未设置，且仓库根没有 .env");
  }
  for (const line of text.split("\n")) {
    const match = /^\s*REACTBITS_LICENSE_KEY\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const raw = match[1]?.trim() ?? "";
    const value = raw.replace(/^["']/, "").replace(/["']$/, "");
    if (value !== "") return value;
  }
  throw new Error("REACTBITS_LICENSE_KEY 未设置");
}

const key = licenseKey();

async function fetchItem(registry: string, name: string): Promise<RegistryItem> {
  const res = await fetch(`${BASE}/${registry}/${name}.json`, {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`${registry}/${name} 返回 HTTP ${res.status}`);
  return (await res.json()) as RegistryItem;
}

// RBP 源码按宽松索引检查写，这里保留项目要求的 noUncheckedIndexedAccess：每次 vendor 后统一补最小兜底。
const STRICT_PATCHES: Record<string, [string, string][]> = {
  "react-bits/speeding-text.tsx": [
    ['slot.textContent = shown ? body[source] : "";', 'slot.textContent = shown ? (body[source] ?? "") : "";'],
    ["slot.textContent = roster[0];", 'slot.textContent = roster[0] ?? "";'],
    ["slot.textContent = roster[cursor];", 'slot.textContent = roster[cursor] ?? "";'],
  ],
  "blocks/monitoring-9.tsx": [
    [
      "next[r.id] = next[r.id] >= 97 ? r.progress! : next[r.id] + 1;",
      "const current = next[r.id] ?? 0;\n          next[r.id] = current >= 97 ? r.progress! : current + 1;",
    ],
  ],
  "blocks/settings-form-1.tsx": [
    ["const [active, setActive] = useState(sections[0].id);", 'const [active, setActive] = useState(sections[0]?.id ?? "");'],
    [
      "const section = sections.find((s) => s.id === active) ?? sections[0];",
      "const section = sections.find((s) => s.id === active) ?? sections[0]!;",
    ],
  ],
  "blocks/bento-29.tsx": [
    ["const claim = claims[index % claims.length];", "const claim = claims[index % claims.length]!;"],
  ],
  "blocks/app-shell-6.tsx": [
    [
      "const doc = ALL_DOCS.find((item) => item.id === selectedId) ?? ALL_DOCS[0];\n  const title = titles[doc.id];",
      'const doc = ALL_DOCS.find((item) => item.id === selectedId) ?? ALL_DOCS[0]!;\n  const title = titles[doc.id] ?? "";',
    ],
  ],
};

const manifest = (await Bun.file(join(appRoot, "reactbits.json")).json()) as Manifest;
const dependencies = new Set<string>();
const written: string[] = [];

for (const entry of manifest.items) {
  const item = await fetchItem(entry.registry, entry.name);
  for (const dep of item.registryDependencies ?? []) {
    if (!(dep in HANDLED_BY_REPO)) throw new Error(`${entry.name} 依赖未处理的 registry 条目 ${dep}`);
  }
  for (const dep of item.dependencies ?? []) dependencies.add(dep);
  if ((item.files ?? []).length === 0) throw new Error(`${entry.name} 没有文件`);
  for (const file of item.files ?? []) {
    if (!file.path.startsWith("components/")) throw new Error(`${entry.name} 文件路径异常：${file.path}`);
    const relative = file.path.slice("components/".length);
    const target = join(outRoot, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
    written.push(relative);
    console.log(`${entry.registry}/${entry.name} -> ${target.slice(repoRoot.length + 1)}`);
  }
}

for (const [relative, pairs] of Object.entries(STRICT_PATCHES)) {
  if (!written.includes(relative)) continue;
  const target = join(outRoot, relative);
  let text = readFileSync(target, "utf8");
  for (const [from, to] of pairs) {
    // 上游改了这几行就得有人重看一眼，宁可 vendor 失败也不要静默漂移
    if (!text.includes(from)) throw new Error(`${relative} 找不到预期的补丁锚点：${from.slice(0, 60)}`);
    text = text.replace(from, to);
  }
  writeFileSync(target, text);
}

console.log(`dependencies: ${[...dependencies].sort().join(" ")}`);
