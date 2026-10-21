import type { VnoteApi } from "../../shared/ipc";

declare global {
  interface Window {
    vnote: VnoteApi;
  }
}

export {};
