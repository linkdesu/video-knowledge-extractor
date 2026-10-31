# ADR-0042: exe 版本资源的产品信息由 app-metadata 单一来源决定，并在构建产物上校验

- 状态：已接受（r67 / issue #89）
- 相关：ADR-0041（exe 版本资源随 package 版本）、r63（安装包缓存内容核对）、`apps/desktop/scripts/app-metadata.ts`

## 背景

ADR-0041 让 electron-builder 重新写 exe 的版本资源，属性页的 `FileVersion` / `ProductVersion` 因此跟上了
`package.json`。但 #89 的验收暴露了同一版本资源里的另外三项：安装后的 `Video Notes.exe` 属性页仍显示

```
公司名：GitHub, Inc.
```

原因是 app-builder-lib 的 `AppInfo.companyName` **只**取自 staging `package.json` 的 `author.name`：

```ts
get companyName() {
  const author = this.info.metadata.author || this.notNullDevMetadata.author;
  return author == null ? null : author.name;
}
```

`package-win.ts` 生成的 staging `package.json` 没有 `author`，于是 `winPackager.signAndEditResources`
根本不写 `CompanyName` 这个键——`Video Notes.exe` 是 electron.exe 的副本，就原样留下了 Electron
（"GitHub, Inc."）的值。产品名与版权没有这个问题，它们来自 `electron-builder.yml` 的
`productName` / `copyright`。

于是同一份产品信息分散在三处：yml 的 `productName`、yml 的 `copyright`、staging package.json 的
`name`/`description`。公司名这一项根本没有落点，缺了也没人发现，直到用户打开属性页。

## 决策

1. **单一来源**：`apps/desktop/scripts/app-metadata.ts` 定义 `APP_PRODUCT_NAME`、`APP_COMPANY_NAME`、
   `APP_COPYRIGHT`、`APP_DESCRIPTION`，并提供：
   - `stagePackageJson(version)` —— staging `package.json`，其中 `author.name` 就是 `CompanyName`；
   - `builderMetadataOverrides()` —— 以 `-c.productName=…`、`-c.copyright=…` 传给 electron-builder。
   `electron-builder.yml` 因此删掉 `productName` / `copyright`，不再两处各写一份（`${productName}`
   宏仍从覆盖后的配置解析，产物名不变）。
2. **在产物上判定，而不是在配置上判定**：`scripts/win-exe-metadata.ts` 用 `resedit`（electron-builder
   自己写这些字段时用的同一个库）读 PE 的 `VS_VERSIONINFO`，`judgeExeMetadata` 是纯函数，
   逐项比对公司名/产品名/版权，并把版本号交给 ADR-0041 的 `assertExeVersionMatches` 判定。
   `scripts/check-win-metadata.ts`（`bun run --cwd apps/desktop check:win-metadata`）默认检查
   `release-win/win-unpacked/Video Notes.exe`——安装后属性页读的就是它。
3. **两处门禁**：
   - `windows-build.yml` 在 `package:win` 之后跑 `check:win-metadata`，坏的元数据不会上传成 CI 产物；
   - `install:local` 在 gamepc 安装完成后读回同样六项，用 `judgeExeMetadata` 判定，不符直接失败。

## 备选与取舍

- **只给 staging package.json 补 `author`**：一行改动即可修好 #89，但 yml 的 `productName`/`copyright`
  与 TS 常量继续各写一份，公司名又只存在于第三处；下次改品牌名仍会漏。选单一来源 + CLI 覆盖。
- **用 PowerShell 的 `VersionInfo` 做门禁**：只能在 Windows 上跑，macOS 上连「对下载的产物复现」都做不到；
  而 GitHub Actions 之外最常用的验证场景正是本机对着下载的 exe 跑。`resedit` 纯 JS，两个平台都能跑。
- **手写 PE 资源解析**：`VS_VERSIONINFO` 的目录树与 UTF-16 字符串块不复杂但容易写错；`resedit`
  已经是 electron-builder 的传递依赖，显式提升为 devDependency 即可。
- **同时校验 setup exe**：NSIS 安装包自身的版本资源不由 `signAndEditResources` 生成，其公司名不是本应用
  配置的直接结果；验收对象是安装后的 exe，故只对 app exe 设门禁。

## 后果

- 安装后的 `Video Notes.exe` 属性页显示 公司名 `xieal`、产品名 `Video Notes`、版权
  `Copyright © 2026 xieal`，版本号仍等于 `package.json`（`0.1.26`）。
- 任何一项被人删掉（例如 staging package.json 丢了 `author`、yml 又把 `productName` 写回去），
  Windows CI 在打包后即失败；`apps/desktop/scripts/win-exe-metadata.test.ts` 用 #89 的真实取值
  （`GitHub, Inc.`）锁定判定文案，不必等 Windows 构建就能发现回归。
- 单测：`win-exe-metadata.test.ts`（公司名/产品名/版权/版本/四段版本/字段缺失/staging author）。
