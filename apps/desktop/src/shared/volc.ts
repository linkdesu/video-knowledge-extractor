import type { VolcengineMode } from "./ipc";

/** 火山引擎的端点与 resource id 是协议常量，不是用户配置（ADR-0016 §2）；这里只用于只读展示。 */
export type VolcModeInfo = { endpoint: string; queryEndpoint?: string; resourceId: string };

export const VOLC_MODE_INFO: Record<VolcengineMode, VolcModeInfo> = {
  flash: {
    endpoint: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
    resourceId: "volc.bigasr.auc_turbo",
  },
  standard: {
    endpoint: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit",
    queryEndpoint: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query",
    resourceId: "volc.seedasr.auc",
  },
};
