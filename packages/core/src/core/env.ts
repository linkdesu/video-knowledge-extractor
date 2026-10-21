import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as dotenvConfig } from "dotenv";

/**
 * 两级加载，顺序即优先级：shell 显式变量 > <cwd>/.env > <root>/.env。
 * root 在 cwd 加载完成后才求值，所以 .env 里的 VNOTE_HOME 能决定第二份文件在哪。
 */
export function loadDotenvFiles(opts: { cwd?: string; resolveRoot: () => string }): string[] {
  const cwdFile = resolve(opts.cwd ?? process.cwd(), ".env");
  const loaded: string[] = [];
  if (existsSync(cwdFile)) {
    dotenvConfig({ path: cwdFile, quiet: true });
    loaded.push(cwdFile);
  }
  const rootFile = resolve(opts.resolveRoot(), ".env");
  if (rootFile !== cwdFile && existsSync(rootFile)) {
    dotenvConfig({ path: rootFile, quiet: true });
    loaded.push(rootFile);
  }
  return loaded;
}
