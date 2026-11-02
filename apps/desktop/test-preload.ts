import { join } from "node:path";
import { installIsolatedTmpDir } from "@video-notes/core/testing/tmp-root";

// #101：本进程独占 <repo>/tmp/test-<pid> 作为 TMPDIR，整轮结束后删除，不污染系统 $TMPDIR。
installIsolatedTmpDir(join(import.meta.dir, "..", ".."));
