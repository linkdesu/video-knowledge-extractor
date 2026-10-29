/**
 * Lab 门禁（r48）：只有未打包的开发态才存在这个页面、它的 IPC 与音频协议。
 * 单独成模块，保证门禁判定可以脱离 Electron 单测。
 */
export function devLabEnabled(isPackaged: boolean): boolean {
  return !isPackaged;
}
