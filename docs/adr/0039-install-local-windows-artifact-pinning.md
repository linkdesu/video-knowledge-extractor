# install:local 的 Windows 安装包按「当前提交 + 当前版本」对齐 CI 产物

issue #81。r60（PR #80）期望装 0.1.19，`install:local` 却把 `main` 上 0.1.18 的构建产物下载进 `tmp/installer/v0.1.19/`，因为 `resolveOrDownloadWinInstaller` 取的是「最近一次成功的 `windows-build` 运行」，不看提交、不看版本。下载 174 MB 之后才因为「目录里找不到 `Video Notes-0.1.19-setup.exe`」失败；一旦目录里残留过同名文件，就会直接把旧版本装到 gamepc。

## Status

已接受（accepted，2026-10-31，r61）。

## 决定

`apps/desktop/scripts/win-installer-source.ts` 定义这些规则，`install-local.ts` 只做 IO：

1. **只认当前提交**：按 `git rev-parse HEAD` 过滤 `gh run list --workflow windows-build.yml`，仅接受 `headSha === HEAD` 且 `status=completed && conclusion=success` 的运行。旧提交的成功运行一律不用；`--win-installer` 仍可手工指定本地包逃生。
2. **产物版本必须等于 package 版本**：选到 run 之后先 `git show <sha>:apps/desktop/package.json` 比对版本，不符直接失败（不浪费 174 MB 下载），报出期望版本、该 run 的版本、run id 与提交短 SHA；下载后再校验 artifact 文件名 `Video Notes-<version>-setup.exe`，清空 `tmp/installer/v<version>/` 之后才落盘，防止上一轮失败留下的旧 exe 冒充本版本。
3. **不等待就不安装**：当前提交的运行还在 `queued` / `in_progress` 时轮询等待（默认 1800 s，`--win-ci-wait-seconds <n>` 覆盖，`0` 表示立刻失败）。等待超时、构建结论非 success、或根本没有该提交的运行记录，都明确报错；**任何路径都不回退到旧提交或旧版本**。
4. **只改文档的收尾提交**：workflow 的 `paths-ignore` 是 `**/*.md` 与 `docs/**`，这类提交没有运行记录。仅当某祖先提交有成功运行、且 `git diff <祖先>..HEAD` 全部落在这些路径上（构建输入逐字节相同）时复用该产物，并打印复用说明；版本门禁照旧生效。
5. **缓存带来源提交**：`tmp/installer/v<version>/` 下载完成后写 `provenance.json`（`runId` + `headSha`）。复用缓存前核对来源提交与 HEAD 的构建输入是否一致；没有来源记录（老目录、手工放进来的包）或来源含代码差异就删掉重下。**版本号相同不代表内容相同**：r61 rebase 后本地同版本缓存仍指向 rebase 前的 commit，实测会照样上传安装。

## 后果

- 期望 0.1.20 时，只有「版本号已同步到 0.1.20 且该提交的 Windows CI 跑绿」才有包可装；版本号没提交就推 CI 会立刻在产物校验处失败，而不是装个旧包糊过去。
- 版本号必须和触发 CI 的同一次提交一致：先改四个 `package.json` 再推送，CI 产物才对得上。
- 单测覆盖在 `apps/desktop/scripts/win-installer-source.test.ts`（版本不符、只认同提交、文档提交复用、缓存来源核对、排队等待、构建失败、超时共 20 例），不依赖网络与 `gh`。
- `release-win/` 下本机 `package:win` 的产物仍直接信任（它由当前工作树打包，文件名带版本号）。
