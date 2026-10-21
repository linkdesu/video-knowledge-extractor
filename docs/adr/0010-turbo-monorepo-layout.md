# turbo 与 bun workspaces 的 monorepo 布局

核心库与 CLI 已经按 [ADR-0007](./0007-core-library-cli-first-and-note-format.md) 分成两个包，但两个包的源码共用根目录一份依赖与一份编译器配置，依赖边界靠自觉维持。把布局定为 turbo + bun workspaces 后，边界写进 package.json，typecheck 与测试在根目录一条命令跑完所有包。

## Status

已接受（accepted）。落实 [ADR-0007](./0007-core-library-cli-first-and-note-format.md) 的包布局。

## 决定

- **工作区与调度**：仓库是 bun workspaces（`apps/*` 与 `packages/*`），turbo 在根目录调度 `typecheck` 与 `test`，跨包依赖由 turbo 的 `dependsOn` 处理。
- **`packages/core`**：独立库包 `@video-notes/core`，一个显式公开入口，重新导出 CLI 需要的流水线、配置、env 与 LLM 端点函数；`sherpa-onnx-node` 等原生依赖归它所有。
- **`apps/cli`**：薄应用包 `vnote`，只做参数解析与终端输出，通过 `workspace:*` 依赖 core，不复制业务逻辑。
- **共享编译器配置**：根目录 `tsconfig.base.json` 定编译选项，各包的 tsconfig 继承它。
- **`apps/desktop` 暂不建**：Electron 这一步后做，届时对着同一个 core 包加 `apps/desktop`。
- **`vnote extract` 行为不变**：dotenv 仍从 cwd 与 notes 根目录各读一份（ADR-0009），缓存与输出目录布局不变（ADR-0002、ADR-0006）。
- **发布不在范围内**：两个包都不进 registry，只走 `workspace:*`。

## Considered Options

- **保持单根包 + `src/` 目录树**：改动最小，但 CLI 与 core 共用一份依赖集，依赖边界没有机器校验，因此不采用。
- **每个模块一个深 subpath 导出（不用 barrel）**：入口更细，但把内部目录结构泄漏给调用方，exports map 随重构膨胀，因此不采用。
- **pnpm 或 npm workspaces**：功能等价，但仓库已经用 bun，turbo 直接识别 `bun.lock`，换锁文件只多一次迁移成本，因此不采用。
- **nx**：能力覆盖 turbo 且更强，但对这个两个包的规模是多余的重，因此不采用。

## 后果

- 两个安装根由同一份 `bun.lock` 解析，native addon 只装一份；turbo 感知 bun workspaces，依赖图自动建立。
- `sherpa-onnx-node` 归 core 所有，Electron 主进程将来仍要按 Electron ABI 重建，或让 CLI 子进程承担转写与切片（ADR-0007）。
- 没有 `test` 脚本的包会被 `turbo run test` 跳过，不会报错；新包忘了加测试脚本时 CI 不会暴露。
- `vnote --version` 读 `apps/cli/package.json` 的 `version`，升级版本时以那一份为准；根与 core 的 `version` 字段不参与输出。
- 共享的 `tsconfig.base.json` 列在 turbo 的 `globalDependencies`，改它会让两个包的 typecheck 与测试缓存一起失效。
