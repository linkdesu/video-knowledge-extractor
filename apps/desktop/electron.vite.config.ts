import { execFileSync } from "node:child_process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { resolve } from "node:path";

// core 是工作区源码，要打进 bundle；原生 addon 与 dotenv 留在 node_modules 里由 Node 运行时加载。
// main bundle 内联构建时的 git 短 sha；失败回落 unknown
function appCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { stdio: "pipe" }).toString().trim() || "unknown";
  } catch {
    return "unknown";
  }
}
const externalNative = ["sherpa-onnx-node"];
export default defineConfig({
  main: {
    // core 是工作区 TS 源码，必须进 bundle；外部化后 Electron 运行时无法 require
    ssr: {
      noExternal: ["@video-notes/core"],
    },
    // 内联构建时的 git 短 sha；只有 main 的启动日志使用
    define: { __APP_COMMIT__: JSON.stringify(appCommit()) },
    build: {
      externalizeDeps: false,
      rollupOptions: {
        external: externalNative,
        input: {
          index: resolve(import.meta.dirname, "src/main/index.ts"),
          "extract-worker": resolve(import.meta.dirname, "src/main/extract-worker.ts"),
          "lab-worker": resolve(import.meta.dirname, "src/main/dev-lab/worker.ts"),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/preload/index.ts") },
        // sandbox 的 preload 只能是 CommonJS；package.json 是 ESM，必须显式改扩展名
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, "src/renderer"),
    // RBP 源码用 `@/lib/utils`，别名指向 renderer 源码根
    resolve: { alias: { "@": resolve(import.meta.dirname, "src/renderer/src") } },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: { input: resolve(import.meta.dirname, "src/renderer/index.html") },
    },
  },
});
