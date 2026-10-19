/** 可选术语表：{"识别错的词": "正确写法", "__prompt__": "可选，作为 ASR 上下文提示"} */
export type Glossary = { replace: Record<string, string>; prompt: string };

export async function loadGlossary(path: string | undefined): Promise<Glossary> {
  if (!path || path === "none") return { replace: {}, prompt: "" };
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`术语表不存在: ${path}`);
  const raw = (await file.json()) as Record<string, unknown>;
  const replace: Record<string, string> = {};
  let prompt = "";
  for (const [from, to] of Object.entries(raw)) {
    if (from === "__prompt__") {
      if (typeof to === "string") prompt = to.trim();
      continue;
    }
    if (typeof to === "string" && from.trim() && to.trim()) replace[from.trim()] = to.trim();
  }
  if (!prompt) {
    const terms = [...new Set(Object.values(replace))];
    if (terms.length) prompt = `本视频术语：${terms.join("、")}。请优先使用这些术语。`;
  }
  return { replace, prompt };
}

export function applyGlossary(text: string, glossary: Record<string, string>): string {
  let out = text;
  for (const [from, to] of Object.entries(glossary)) {
    if (/^[A-Za-z0-9 ._+-]+$/.test(from)) {
      const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "gi"), to);
    } else {
      out = out.split(from).join(to);
    }
  }
  return out;
}
