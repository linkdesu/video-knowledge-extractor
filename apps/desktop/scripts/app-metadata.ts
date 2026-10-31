/**
 * Windows 版本资源（exe 属性页）里本应用的自述信息（r67 / #89）。
 *
 * electron-builder 的 `CompanyName` **只**来自 staging package.json 的 `author.name`
 * （app-builder-lib `AppInfo.companyName` 的实现），没提供时它根本不写这个键，
 * exe 就保留 electron.exe 自带的 "GitHub, Inc."。
 *
 * 因此这里同时是：staging package.json 的生成源、electron-builder 的 productName/copyright
 * 覆盖值、以及产物校验脚本（check-win-metadata.ts）的期望值 —— 三处读同一份常量，不各写一套。
 */

export const APP_PRODUCT_NAME = "Video Notes";
export const APP_COMPANY_NAME = "xieal";
export const APP_DESCRIPTION = "把长视频变成可按主题阅读的笔记";
export const APP_COPYRIGHT = "Copyright © 2026 xieal";

/** `release-win/stage/package.json`：electron-builder 读取应用元数据的唯一来源。 */
export function stagePackageJson(version: string): Record<string, unknown> {
  return {
    name: "video-notes",
    productName: APP_PRODUCT_NAME,
    version,
    description: APP_DESCRIPTION,
    // exe 版本资源的 CompanyName 只从 author.name 取（app-builder-lib AppInfo.companyName），
    // 没有 author 时它不写这个键，属性页会保留 electron.exe 的 "GitHub, Inc."。
    author: { name: APP_COMPANY_NAME },
    main: "out/main/index.js",
    type: "module",
    private: true,
  };
}

/**
 * 传给 electron-builder 的 `-c.` 覆盖项。
 * productName / copyright 只在这份常量里定义，electron-builder.yml 不再重复写死。
 */
export function builderMetadataOverrides(): string[] {
  return [`-c.productName=${APP_PRODUCT_NAME}`, `-c.copyright=${APP_COPYRIGHT}`];
}
