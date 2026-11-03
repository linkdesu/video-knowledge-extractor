# ADR-0047: Windows 安装包的 asar 用白名单门禁，staging 必须声明运行时依赖

- 状态：已接受（r72 / issue #96）
- 相关：ADR-0028（Windows 打包）、ADR-0043（在产物上判定）、`apps/desktop/scripts/asar-manifest.ts`、`apps/desktop/electron-builder.yml`

## 背景

CI run 41402337086 的 Windows 安装包里 `resources/app.asar` 有 156 项，mac 包只有 36 项。多出来的部分是
`node_modules/@video-notes/core/**`（整份 `src/`，含 `*.test.ts` 与 `__snapshots__`，
以及 `packages/core/.turbo/turbo-test.log`、`turbo-typecheck.log`、`bunfig.toml`、`tsconfig.json`）
和 `dotenv`。功能代码（`out/` 下的 bundle）与 mac 逐字节相同，只是包体变大，并且可能把本机路径等
构建期信息带进安装包。

根因在 electron-builder 的依赖收集顺序（`app-builder-lib` 的 `collectNodeModulesWithLogging`）：
它按 `[appDir, projectDir, workspaceRoot]` 依次找 `node_modules`，**第一个返回空就换下一个**。
我们的 `appDir` 是 `release-win/stage`，而 `scripts/app-metadata.ts` 生成的 staging `package.json`
里没有 `dependencies`，于是日志里出现

```
searching for node modules  pm=bun searchDir=…/release-win/stage
no node modules found in collection, trying next search directory  searchDir=…/release-win/stage attempt=0
searching for node modules  pm=bun searchDir=…/apps/desktop
```

收集器于是拿 `apps/desktop/package.json` 的依赖重算了一遍：`@video-notes/core` 是指向
`packages/core` 的 workspace 符号链接，`cpSync`/收集都解引用，整份源码连同 `.turbo` 日志进包；
它的运行期依赖 `dotenv` 也跟着进包（`sherpa-onnx-*` 的其它平台包同理）。

`files` 里的 `node_modules/**` 不是问题所在：白名单本身没放行这些文件，是收集器绕过了 `files` 的包含
规则（它对每个依赖目录只用 `files` 里的 `!` 排除模式）。

## 决策

1. **staging `package.json` 声明运行时依赖**：`stagePackageJson(version, dependencies)` 必须写出
   `sherpa-onnx-node` 与 `sherpa-onnx-win-x64`，版本号从真正被复制进 stage 的那两个包读取
   （`package-win.ts` 里 `packageVersion()`），不另立常量。收集器在 `appDir` 就拿到非空依赖集合，
   不再回退到 `apps/desktop`。这是根因修复，`files` 白名单保持不变。
2. **`electron-builder.yml` 加第二道拦截**：`!**/@video-notes/**`、`!**/*.test.ts`、`!**/*.snap`、
   `!**/__snapshots__/**`、`!**/.turbo/**`、`!**/*.log`。这些是依赖目录唯一可用的排除手段，
   万一依赖收集再次回退，测试、快照与构建日志也不会进包（实测：回退但只保留排除时 160 → 45 项，
   仍被第 3 条门禁判失败）。
3. **在产物上判定，用白名单而不是黑名单**：`scripts/asar-manifest.ts` 直接读 asar 头部的清单 JSON，
   只允许 `out/**`、`package.json`、`node_modules/sherpa-onnx-node/**` 与当前平台的
   `node_modules/sherpa-onnx-<platform>/**`；白名单外的任何条目都失败，并给出人话原因
   （测试文件 / 快照 / turbo 日志 / dotenv / workspace 源码 / 其它平台原生包）。
   同时要求几个必须存在的运行时文件，避免「空 asar 也过白名单」的假通过。
4. **两个门禁入口**：
   - CI：`windows-build.yml` 在 `Package (NSIS)` 与 `check:win-metadata` 之后跑
     `bun run --cwd apps/desktop check:app-asar`，坏包不上传；
   - 本机：同一命令加 `--win <win asar> --mac <mac asar>`，按平台折叠原生包目录、忽略 `*.md`
     后逐条比对，输出 `parity.onlyInLeft/onlyInRight`（Windows 与 mac 结构一致才算过）。

## 备选与取舍

- **只加 `files` 排除**：能挡住测试/日志，挡不住 `core/src/*.ts` 这种「看起来像源码的运行时文件」，
  也挡不住未来新引入的依赖；而且排除清单永远追不上新泄漏。
- **把 staging 挪到仓库外**：`collectNodeModulesWithLogging` 的搜索目录里始终有 `projectDir` 与
  workspace 根，挪位置只是换个回退目标。
- **`files` 写成只有 `out/**` + `package.json`，让收集器负责 node_modules**：实测收集器仍会在
  `appDir` 为空时回退，问题不变；而且 `.node`/dll 的解包规则依赖依赖树，拆开更脆。
- **黑名单式门禁（禁 `*.test.ts`、`.turbo`）**：只覆盖这次见过的偷带，新增来源（别的 workspace、
  构建缓存目录、新的 npm 依赖）照样漏。白名单把「允许什么」写成有限集合，成本一样。
- **在配置上断言（读 yml 断言有 `!` 规则）**：测的是配置文本，不是产物；#96 的教训正是配置看起来
  没问题、产物不对。

## 后果

- Windows 包 asar 从 156 项降到 35 项（`out/` 9、`package.json` 1、`sherpa-onnx-node` 18、
  `sherpa-onnx-win-x64` 7）；mac 包 36 项，唯一差异是 mac 多一个 `sherpa-onnx-node/README.md`。
- `check:app-asar` 对 0.1.28 CI 产物（156 项）退出码 1，逐条列出 121 项白名单外文件；
  对修复后的 0.1.31 本机包退出码 0。
- 单测：`asar-manifest.test.ts`（干净清单、前导斜杠、真实泄漏样本、跨平台原生包、缺运行时文件、
  形状折叠与差异、asar 头解析、非 asar 文件的错误文案）。
- 以后新增运行时依赖必须同时出现在 staging `dependencies` 里，否则 CI 直接红。
