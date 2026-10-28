/**
 * 多轮设计原型的纯逻辑（decision card 的读写、种子追加、open questions 计数）。
 * 从 website-workflow 的 `verify prototype` 移植并适配 video-notes：没有
 * light/dark 双主题、没有 theme-toggle / lang-toggle，选择器基线换成真实的
 * `[data-testid]`。进程副作用（写文件、跑 concept-seed、CDP 抓基线）在
 * verify.ts 里，这里只放可单测的纯函数。
 */
export const CONFIRMED = "## Confirmed (本轮确认)";
export const REJECTED = "## Rejected (本轮否决)";
export const OPEN_QUESTIONS = "## Open Questions (待决分歧)";
export const KEY_SELECTORS = "## Key Selectors (data-testid)";

const CANONICAL_SECTIONS = [CONFIRMED, REJECTED, OPEN_QUESTIONS, KEY_SELECTORS];

export const SELECTOR_BASELINE = [
  '`[data-testid="app-version"]` — 侧边栏版本号（required）',
  '`[data-testid="nav-library"]` / `nav-glossary` / `nav-settings` — 侧栏导航（required）',
  '`[data-testid="job-banner"]` — 任务浮层（optional，仅任务时出现）',
];

export const NONE_LINES: Record<string, true> = { "- none": true, "- 无": true, "none": true, "无": true, "- (none)": true };

/** `--round <N>`：必须是非零正整数。 */
export function parseRound(value: string | undefined): number {
  if (!value) throw new Error("--round <N> is required (an integer >= 1)");
  if (!/^[0-9]+$/.test(value) || Number(value) < 1) {
    throw new Error(`--round expects an integer >= 1, got ${JSON.stringify(value)}`);
  }
  return Number(value);
}

/** 逗号（或换行）分隔的列表，逐条 trim。 */
export function listed(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** `PRODUCT.md` 的结构化模板；`seed` 为第一句需求种子。 */
export function productTemplate(slug: string, seed: string | null): string {
  return `# PRODUCT — ${slug}

The product truth every design round converges on. Each prototype round fills
the open questions here; the freeze gate refuses to close while a section is
still a guess.

## One-liner

${seed ? `${seed}` : "- (one sentence: what this is and who it is for)"}

## Users

- (who uses it, in what situation, on what device)

## Core journeys

- (the two or three walks a first version must make feel inevitable)

## Constraints

- (copy language, brand, integrations, hard limits)

## Open questions

- (what the next prototype round must settle)
`;
}

/** 把新种子追加进 `## Seed (design prototype rounds)`；不存在则新增该节。 */
export function appendSeeds(markdown: string, seeds: string[]): string {
  if (seeds.length === 0) return markdown;
  const heading = "## Seed (design prototype rounds)";
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    return `${markdown.replace(/\n*$/, "\n")}\n${heading}\n\n${seeds.map((seed) => `- ${seed}`).join("\n")}\n`;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]!.startsWith("## ")) {
      end = index;
      break;
    }
  }
  const body = lines.slice(start + 1, end);
  for (const seed of seeds) {
    if (!body.some((line) => line.trim() === `- ${seed}`)) body.push(`- ${seed}`);
  }
  return [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join("\n");
}

/** Split a card into preamble + `## ` sections, keeping unknown sections. */
export function splitSections(markdown: string): { preamble: string[]; sections: Array<{ heading: string; body: string[] }> } {
  const preamble: string[] = [];
  const sections: Array<{ heading: string; body: string[] }> = [];
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) sections.push({ heading: line.trim(), body: [] });
    else if (sections.length === 0) preamble.push(line);
    else sections.at(-1)!.body.push(line);
  }
  return { preamble, sections };
}

export function mergeBullets(existing: string[], added: string[], fallback: string[]): string[] {
  const merged = existing
    .filter((line) => !(line.trim().toLowerCase() in NONE_LINES))
    .filter((line) => line.trim().length > 0);
  for (const entry of added) {
    const bullet = `- ${entry}`;
    if (!merged.some((line) => line.trim() === bullet)) merged.push(bullet);
  }
  return merged.length > 0 ? merged : fallback;
}

/**
 * 用新 header + 本轮增量重写卡片：四个规范节固定，未知节保留在末尾。
 * `clearOpen` 把待决项重置为 `- None`（`--open None` / `无` / `clear` 的语义）。
 */
export function renderCard(
  markdown: string,
  header: string[],
  additions: { confirmed: string[]; rejected: string[]; open: string[] },
  clearOpen: boolean,
): string {
  const { sections } = splitSections(markdown);
  const byHeading = new Map(sections.map((section) => [section.heading, section.body]));
  byHeading.set(
    CONFIRMED,
    ["", ...mergeBullets(byHeading.get(CONFIRMED) ?? [], additions.confirmed, ["- None"]), ""],
  );
  byHeading.set(
    REJECTED,
    ["", ...mergeBullets(byHeading.get(REJECTED) ?? [], additions.rejected, ["- None"]), ""],
  );
  byHeading.set(
    OPEN_QUESTIONS,
    ["", ...(clearOpen ? ["- None"] : mergeBullets(byHeading.get(OPEN_QUESTIONS) ?? [], additions.open, ["- None"])), ""],
  );
  byHeading.set(KEY_SELECTORS, ["", ...mergeBullets(byHeading.get(KEY_SELECTORS) ?? [], SELECTOR_BASELINE, ["- None"]), ""]);

  const order = [...CANONICAL_SECTIONS, ...sections.map((section) => section.heading).filter((h) => !CANONICAL_SECTIONS.includes(h))];
  const lines = [...header];
  for (const heading of order) {
    lines.push(heading, ...byHeading.get(heading) ?? [""]);
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n")}`;
}

export function cardTemplate(round: number, runId: string, slug: string): string {
  return `# Round ${round} — Decision Card (${slug})

Decision card for prototype round ${round} of run \`${runId}\`. One card per
round; the next round starts from this one.

## Confirmed (本轮确认)

- None

## Rejected (本轮否决)

- None

## Open Questions (待决分歧)

- None

## Key Selectors (data-testid)

${SELECTOR_BASELINE.map((line) => `- ${line}`).join("\n")}
`;
}

/** Count the open questions: every bullet/line under the heading except the `None` placeholder. */
export function countOpenQuestions(markdown: string): number {
  const { sections } = splitSections(markdown);
  const section = sections.find((candidate) => candidate.heading === OPEN_QUESTIONS);
  if (!section) throw new Error(`decision card has no "${OPEN_QUESTIONS}" section`);
  return section.body.filter((line) => {
    const text = line.trim();
    return text.length > 0 && !(text.toLowerCase() in NONE_LINES);
  }).length;
}
