# ADR-0040: 旧密钥迁移只认 v10/v11、迁移提示后置，exe 版本资源随 package 版本

- 状态：已接受（r64 / issue #71）
- 相关：ADR-0015 §3（密钥只在主进程）、r44（弃用 safeStorage 改 0o600 本地 JSON）、r45c（Windows DPAPI 一次性迁移）、r45 QA GAP-1（迁移成功仍打「已失效」WARN）

## 背景

三件事挤在一起，都是 r45c 留下的尾巴：

1. **误报 WARN**：`readStored` 一读到非 JSON 内容就在 `setAsideLegacy` 里无条件写
   `WARN 旧版系统加密密钥已失效，已备份并重置`，而真正的迁移尝试发生在其后。Windows 上迁移成功时，
   日志里先出现「已失效」，紧接着才是「已迁移」（r45 QA 记录为 GAP-1）。
2. **误判范围**：`plainFileCodec` 把**任何**不以 `{` 开头的内容都当成旧版密文——空文件、BOM、
   被截断的写入、别人的乱码文件都会触发「旧密钥迁移」。Electron 自己的 `safeStorage.decryptString`
   只接受 `v10` / `v11` 前缀，我们却比它宽松。
3. **弃用接口**：Electron 45 弃用了同步的 `safeStorage.isEncryptionAvailable()` / `decryptString()`，
   r45c 的迁移钩子正好只用这两个。运行时会打弃用警告。

另外，`electron-builder.yml` 里 `win.signAndEditExecutable: false` 让打包器不写 exe 的版本资源：
安装后的 `Video Notes.exe` 属性页显示的是 Electron 的版本，不是 package.json 的版本（issue #71 验收第 2 条）。

## 决策

1. **旧密钥判定与 Electron 对齐**：只有前三个字节是 `v10` / `v11` 的文件才算旧版 safeStorage 密文
   （`looksLikeLegacyCipher`）。其余非 JSON 内容按「密钥文件内容无法识别，已备份并重置」处理，
   只留一条 WARN，**不发起迁移**——没有旧密钥就不出现任何迁移字样。
2. **提示跟着结果走**：`setAsideUnreadable` 只做文件搬家并返回备份路径，不写日志。迁移结果由
   `store.migrateLegacy(decrypt)` 决定：
   - 无旧密文 → `"none"`，不调用 `decrypt`，不写日志；
   - 成功 → 一条 INFO「已迁移」，不再有前置 WARN；
   - 失败 / 平台不提供解密（macOS 的钥匙串绑 cdhash）→ 一条 WARN，带备份路径与原因。
3. **改用异步 API**：`createSecretStore` 保持同步；迁移是启动时的一次显式 `await store.migrateLegacy(...)`，
   Windows 用 `safeStorage.decryptStringAsync().result`，其它平台传 `null`。同步的弃用接口不再有调用方。
4. **exe 版本资源**：删掉 `signAndEditExecutable: false`（回到默认 true），让 electron-builder 把
   `version` 写进 `Video Notes.exe` 的 FileVersion / ProductVersion；`install:local` 在 PowerShell 侧读回
   这两个值，由 `assertExeVersionMatches`（按段比较，`0.1.23.0` 等同 `0.1.23`）对 `package.json` 校验。
   setup exe 的 FileVersion 只打印、不作为门禁——用户读的是安装后的 exe 属性页。

## 备选与取舍

- **彻底删掉迁移逻辑**：代码最少，但会让仍停留在 ≤0.1.0 的 Windows 安装丢掉 key；既然异步 API 还在，
  保留兼容路径的代价只是一次 `await`。
- **保留同步 API 并只修 WARN 顺序**：Electron 45 已弃用，未来主版本移除后启动即崩，不能接受。
- **用 `isAsyncEncryptionAvailable()` 先门控**：它会在启动时初始化加密器；没有旧密文时我们根本不需要它。
  `migrateLegacy` 只在真的有旧密文时才调用解密，失败（含 “temporarily unavailable”）按 WARN 处理。
- **把 pending 事务的旧密文也迁移**：pending 是「事务重放」，没有可解密的下游语义；继续只做备份并跳过。

## 后果

- 迁移成功只剩一条 INFO；没有旧密钥的安装（绝大多数）启动时完全不碰 `safeStorage`。
- 空文件 / 乱码不再冒充「旧密钥」，排查时看到的是准确文案与 `.legacy-*` 备份路径。
- 安装后 exe 属性页的版本与侧栏 `v<version>`、注册表 `DisplayVersion`、`app.asar` 内版本一致；
  一旦打包配置退回 `signAndEditExecutable: false`，`install:local` 会在 Windows 侧直接失败。
- 单测覆盖：`apps/desktop/src/main/secrets.test.ts`（成功/失败/无旧密文/非旧密文/no-op）、
  `apps/desktop/src/main/release-version.test.ts`（FileVersion / ProductVersion 比较）。
