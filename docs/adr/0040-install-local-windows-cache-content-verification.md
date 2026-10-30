# install:local 的 Windows 安装包缓存以 CI 产物摘要为锚点

issue #86。r62 验收时发现 gamepc 上装的是上一个提交缓存下来的安装包：r61（ADR 0039）的 `provenance.json` 只记了 `runId` 与 `headSha`，缓存命中时不再核对文件内容——被截断/替换过的 exe、或手工写进 `tmp/installer/v<version>/` 的 `provenance.json`，都会被静默上传安装。第一版修法（记录 exe 的 `fileSha256` 并在命中时重算）仍然不够：**exe 的哈希是本地自报的，改 exe 的同时改掉记录里的哈希就能一起混过去**，而且从来没核对过「这份产物到底是哪个提交打的」。

## Status

已接受（accepted，2026-10-31，r63）。

## 决定

`apps/desktop/scripts/win-installer-source.ts` 定义这些规则，`install-local.ts` 只做 IO：

1. **缓存里保存 CI 产物本身（`artifact.zip`），它是唯一可信内容**：`tmp/installer/v<version>/` 同时存 `artifact.zip` 与 `provenance.json`（schema v2：`runId`、`headSha`、`artifactDigest`、`artifactSizeBytes`、`fileName`、`fileSizeBytes`、`fileSha256`）。安装包**每次从这份 zip 解出来**，目录里残留的 exe 只当派生物，不单独信任；`fileSha256` 只用于核对「解出来的字节就是当时记下的字节」，不作为信任来源。为什么是 zip 而不是 exe 哈希：GitHub 的 `digest` 是 artifact zip 的 sha256，只有保存了 zip，缓存内容才能重新与这个可信锚点对上——无法伪造，也无法在保留记录的同时替换内容。
2. **缓存命中前五条核对**：(a) `provenance.json` 是可解析的新格式（r61 的 `runId` + `headSha` 老格式视为没有来源）；(b) 记录的文件名等于期望版本的 `Video Notes-<version>-setup.exe`；(c) `artifact.zip` 存在，大小与 sha256 等于记录里的 CI 摘要（半包/篡改在这里挂）；(d) 现查该 run 的产物元数据：`workflow_run.id`、`workflow_run.head_sha`、`digest` 三者都要与记录一致——记录不可能凭空把自己指向 HEAD，产物也必须真是记录里那个提交打的；(e) 从 zip 解出的安装包大小与 `fileSha256` 与记录一致。任一条不过就删缓存重下，并打印具体是哪一条、记录值与实际值各是多少。
3. **HEAD 已有自己那次 CI 产物时，绝不使用别的提交的缓存**：判据是「该提交有成功运行、且该提交的 `package.json` 版本等于本版本」。哪怕旧缓存只差文档、摘要全对也不复用——HEAD 自己的产物才是这一提交的真实构建。
4. **只有 HEAD 自己没有运行、且与祖先提交的 diff 全是不触发构建的路径（`**/*.md`、`docs/**`，与 workflow 的 `paths-ignore` 一致）时才复用祖先产物**：构建输入逐字节相同，产物等价于 HEAD 的构建。此时输出必须明确写出「安装包来自其他提交：run X @ sha」，summary 里 `fromOtherCommit: true`，另打印一行 `⚠ 注意：安装的包不是 HEAD 自己那次 CI 打的`。
5. **下载路径同样核对**：用 `gh api repos/<slug>/actions/artifacts/<id>/zip` 把 zip 落盘，sha256 必须等于 CI 摘要，且产物自带的 `workflow_run.id` / `head_sha` 必须等于要下载的那个 run 与提交；不符立刻删掉整个版本目录并失败（半成品缓存不许留，否则下次会被当成可核对来源）。为什么换掉 `gh run download`：它只给解压后的文件，不提供 zip，无法与 `digest` 比对。摘要缺失、产物过期到无法下载时拒绝自动安装，提示改走 `release-win/` 本机打包或 `--win-installer` 手工指定。
6. **产物已过期但仍持有摘要匹配的 zip：缓存可用**：可信锚点就是摘要，产物被 GitHub 清理不影响「这份 zip 等于那次构建」。只有查不到产物元数据（记录被清空、digest 缺失）时才判定缓存不可信并重下。
7. **上传 gamepc 后用 `Get-FileHash` 核对远端 sha256**，与本地 `fileSha256` 不符就中止安装——上传通道（scp）损坏或写了一半的文件也要在装之前拦住。
8. **新增 `--win-download-only`**：只解析/下载/打印来源与哈希，不连 gamepc、不上传、不安装。证据取证与排障不应触碰 gamepc（本轮 gamepc 实装被 #83 的 QA 门禁挡住时，就是靠它完成取证）；`summary` 里 `windows.installer` 给出 `source` / `file` / `fileSizeBytes` / `fileSha256` / `runId` / `headSha` / `artifactDigest` / `fromOtherCommit`。

## 后果

- 缓存体积翻倍（zip + 解出的 exe 各约 174 MB），换来的是「装之前内容一定能回溯到某次 CI 产物」；`tmp/` 已在 gitignore 内，不进仓库。
- 每次缓存命中多一次 zip 解包与两次哈希（zip 与解出的 exe），约 2–3 s，比 174 MB 重新下载便宜得多。
- CI 产物摘要成为唯一可信锚点：查不到产物元数据时缓存失效，需要重新打包或重新触发 CI；产物过期但仍持有 zip 时缓存继续可用。
- `release-win/` 本机 `package:win` 的产物与 `--win-installer` 手工指定仍然绕过 CI 核对（没有 CI digest 可比），但会在输出里标明来源。
- 单测覆盖在 `apps/desktop/scripts/win-installer-source.test.ts`（38 例：格式解析、摘要/大小/所属提交不符、HEAD 自有产物优先、文档复用、排队等待、构建失败、超时），不依赖网络与 `gh`。
