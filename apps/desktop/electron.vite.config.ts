import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// core 是工作区源码，要打进 bundle；原生 addon 与 dotenv 留在 node_modules 里由 Node 运行时加载。
const externalNative = ["sherpa-onnx-node"];

export default defineConfig({
  main: {
    // core 是工作区 TS 源码，必须进 bundle；外部化后 Electron 运行时无法 require
    ssr: {
      noExternal: ["@video-notes/core"],
    },
    build: {
      externalizeDeps: false,
      rollupOptions: {
        external: externalNative,
        input: {
          index: resolve(import.meta.dirname, "src/main/index.ts"),
          "extract-worker": resolve(import.meta.dirname, "src/main/extract-worker.ts"),
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
    plugins: [react()],
    build: {
      rollupOptions: { input: resolve(import.meta.dirname, "src/renderer/index.html") },
    },
  },
});
