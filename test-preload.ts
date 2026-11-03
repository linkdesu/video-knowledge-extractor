import { installIsolatedTmpDir } from "./packages/core/src/testing/temp-dirs-preload";

// #101：仓库根 `bun test`（test:tools 等）同样独占 <repo>/tmp/test-<pid>，跑完删除。
installIsolatedTmpDir(import.meta.dir);
