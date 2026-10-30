# install:local 的 Windows 安装包缓存命中前必须核对内容

issue #86。r62 验收时发现 gamepc 上装的是上一个提交缓存下来的安装包：r61（ADR 0039）的 `provenance.json` 只记了 `runId` 与 `headSha`，缓存命中时不再核对文件内容——被截断/替换过的 exe、或手工写进 `tmp/installer/v<version>/` 的 `provenance.json`，都会被静默上传安装。

## Status

已接受（accepted，2026-10-31，r63）。

## 决定

`apps/desktop/scripts/win-installer-source.ts` 定义这些规则，`install-local.ts` 只做 IO：

1. **provenance 升 v2（`PROVENANCE_SCHEMA_VERSION = 2`）**：记录 `runId`、`headSha`、`artifactDigest`（CI artifact zip 的 sha256，取自 `gh api repos/<slug>/actions/runs/<id>/artifacts` 的 `digest` 字段）、`artifactSizeBytes`、`fileName`、`fileSizeBytes`、`fileSha256`。为什么要记内容哈希：r61 的 provenance 只证明「从哪个 run 下的」，不证明「文件现在还是那个内容」；`fileSha256` 挡住本地文件被截断/替换，`artifactDigest` 把记录锚回 CI 侧的可信摘要。r61 老格式（只有 `runId` + `headSha`）视为没有来源，直接丢弃重下——不猜、不降级。
2. **缓存命中前四条核对**：(a) 本地文件存在且文件名等于期望版本的 `Video Notes-<version>-setup.exe`；(b) 文件大小与 sha256 等于 provenance 记录（半包/篡改在这里挂）；(c) 现查该 run 的 CI 产物摘要与记录一致（run id 与 digest 都要对上）；(d) 来源提交与 HEAD 的关系允许（见 3/4）。任一条不过就删缓存重下，并打印具体是哪一条、记录值与实际值各是多少——理由要能直接看出「哪里不对」，而不是一句「缓存不可信」。
3. **HEAD 已有自己那次 CI 产物时，绝不使用别的提交的缓存**：判据是「该提交有成功运行、且该提交的 `package.json` 版本等于本版本」。哪怕旧缓存只差文档、哈希全对也不复用——因为 HEAD 自己的产物才是这一提交的真实构建，旧提交产物是「等价但非本提交」，能装自己的就不该装别人的。
4. **只有 HEAD 自己没有运行、且与祖先提交的 diff 全是不触发构建的路径（`**/*.md`、`docs/**`，与 workflow 的 `paths-ignore` 一致）时才复用祖先产物**：构建输入逐字节相同，产物等价于 HEAD 的构建。此时输出必须明确写出「安装包来自其他提交：run X @ sha」，summary 里 `fromOtherCommit: true`，另打印一行 `⚠ 注意：安装的包不是 HEAD 自己那次 CI 打的`——来源必须显式可见，不能静默。
5. **下载路径同样核对**：用 `gh api repos/<slug>/actions/artifacts/<id>/zip` 把 zip 落盘，zip 的 sha256 必须等于 CI digest，不符立即删除并失败。为什么要换掉 `gh run download`：它只给解压后的文件，不提供 zip 本身，无法与 `digest` 比对——下载环节就失去唯一可信锚点。CI 产物摘要缺失（未上报）或产物过期时拒绝自动安装，提示改走 `release-win/` 本机打包或 `--win-installer` 手工指定。
6. **上传 gamepc 后用 `Get-FileHash` 核对远端 sha256**，与本地 `fileSha256` 不符就中止安装——上传通道（scp）损坏或写了一半的文件也要在装之前拦住。
7. **新增 `--win-download-only`**：只解析/下载/打印来源与哈希，不连 gamepc、不上传、不安装。为什么单独留一条不连远端的路径：证据取证与排障时不应触碰 gamepc（本轮 gamepc 实装被 #83 QA 门禁挡住时，就是靠它完成取证）；`summary` 里 `windows.installer` 给出 `source` / `file` / `fileSizeBytes` / `fileSha256` / `runId` / `headSha` / `artifactDigest` / `fromOtherCommit`。

## 后果

- 同版本缓存不能只靠 run id 复用：`tmp/installer/v<version>/` 命中前必须四条核对全过，任何一条失败都删缓存重下并打印理由。
- CI 产物摘要成为唯一可信锚点：产物过期（GitHub 默认 90 天）后 digest 查不到，缓存随之失效，需重新打包或重新触发 CI。
- `release-win/` 本机 `package:win` 的产物与 `--win-installer` 手工指定仍然绕过 CI 核对（它们没有 CI digest 可比），但会在输出里标明来源与「内容哈希未知/无法核对」。
- 单测覆盖在 `apps/desktop/scripts/win-installer-source.test.ts`（35 例），不依赖网络与 `gh`。
