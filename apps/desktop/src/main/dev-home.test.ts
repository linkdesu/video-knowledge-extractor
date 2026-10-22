import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareDevHome, resolveDevHome } from "./dev-home";

const tmp: string[] = [];

function fixture(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `vnote-devhome-${name}-`));
  tmp.push(dir);
  return dir;
}

function repoFixture(): string {
  const root = fixture("repo");
  mkdirSync(join(root, "apps", "desktop"), { recursive: true });
  writeFileSync(join(root, "turbo.json"), "{}");
  writeFileSync(join(root, "apps/desktop/package.json"), "{}");
  return root;
}

afterEach(() => {
  for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveDevHome", () => {
  test("未打包且 cwd 是仓库根：返回 tmp/dev-home 三段", () => {
    const root = repoFixture();
    const res = resolveDevHome({ isPackaged: false, cwd: root, env: {} });
    expect(res).not.toBeNull();
    expect(res?.root).toBe(join(root, "tmp", "dev-home"));
    expect(res?.userData).toBe(join(root, "tmp", "dev-home", "user-data"));
    expect(res?.dataRoot).toBe(join(root, "tmp", "dev-home", "data"));
  });

  test("cwd 深入仓库内多层（不超过 6 层）也能找到根", () => {
    const root = repoFixture();
    const deep = join(root, "apps", "desktop", "src", "main");
    mkdirSync(deep, { recursive: true });
    const res = resolveDevHome({ isPackaged: false, cwd: deep, env: {} });
    expect(res?.root).toBe(join(root, "tmp", "dev-home"));
  });

  test("打包：返回 null", () => {
    const root = repoFixture();
    expect(resolveDevHome({ isPackaged: true, cwd: root, env: {} })).toBeNull();
  });

  test("找不到仓库根：返回 null", () => {
    const bare = fixture("bare");
    expect(resolveDevHome({ isPackaged: false, cwd: bare, env: {} })).toBeNull();
  });

  test("超过 6 层找不到仓库根：返回 null", () => {
    const root = repoFixture();
    let dir = root;
    for (const n of ["a", "b", "c", "d", "e", "f", "g"]) {
      dir = join(dir, n);
      mkdirSync(dir, { recursive: true });
    }
    expect(resolveDevHome({ isPackaged: false, cwd: dir, env: {} })).toBeNull();
  });

  test("只有 turbo.json 没有 apps/desktop/package.json：不是仓库根", () => {
    const root = fixture("notrepo");
    writeFileSync(join(root, "turbo.json"), "{}");
    mkdirSync(join(root, "apps", "desktop"), { recursive: true });
    expect(resolveDevHome({ isPackaged: false, cwd: root, env: {} })).toBeNull();
  });
});

describe("prepareDevHome", () => {
  test("建好 root/user-data/data/data/.cache；真实根已有模型目录时建 models 符号链接", () => {
    const home = fixture("home");
    const realRoot = join(home, "Documents", "video-notes");
    mkdirSync(join(realRoot, "models"), { recursive: true });
    writeFileSync(join(realRoot, "models", "marker"), "1");
    const devHome = { root: join(home, "dev-home"), userData: join(home, "dev-home", "user-data"), dataRoot: join(home, "dev-home", "data") };
    prepareDevHome(devHome, { HOME: home });
    expect(existsSync(devHome.root)).toBe(true);
    expect(existsSync(devHome.userData)).toBe(true);
    expect(existsSync(devHome.dataRoot)).toBe(true);
    expect(existsSync(join(devHome.dataRoot, ".cache"))).toBe(true);
    const link = join(devHome.dataRoot, "models");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(link, "marker"))).toBe(true);
  });

  test("models 目标解析 VNOTE_HOME/models，其次 ~/.cache/video-notes/models", () => {
    const home = fixture("home2");
    const fallback = join(home, ".cache", "video-notes", "models");
    mkdirSync(fallback, { recursive: true });
    writeFileSync(join(fallback, "marker2"), "1");
    const devHome = { root: join(home, "dev-home"), userData: join(home, "dev-home", "user-data"), dataRoot: join(home, "dev-home", "data") };
    prepareDevHome(devHome, { HOME: home });
    const link = join(devHome.dataRoot, "models");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(link, "marker2"))).toBe(true);
  });

  test("没有现成模型目录时不建链接（不建空目录）", () => {
    const home = fixture("home3");
    const devHome = { root: join(home, "dev-home"), userData: join(home, "dev-home", "user-data"), dataRoot: join(home, "dev-home", "data") };
    prepareDevHome(devHome, { HOME: home });
    expect(existsSync(join(devHome.dataRoot, "models"))).toBe(false);
  });

  test("幂等：真实根已有模型目录时，重复调用仍保留符号链接", () => {
    const home = fixture("home4");
    const realRoot = join(home, "Documents", "video-notes");
    mkdirSync(join(realRoot, "models"), { recursive: true });
    writeFileSync(join(realRoot, "models", "marker"), "1");
    const devHome = { root: join(home, "dev-home"), userData: join(home, "dev-home", "user-data"), dataRoot: join(home, "dev-home", "data") };
    prepareDevHome(devHome, { HOME: home });
    prepareDevHome(devHome, { HOME: home });
    const link = join(devHome.dataRoot, "models");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(link, "marker"))).toBe(true);
  });
});
