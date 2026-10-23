/**
 * 草稿优先：base url 与 key 都取表单当前值；key 留空时回落到已存密钥，其次 dev 模式种子。
 * 纯函数，便于单测：返回凭据对象，否则返回可读错误文案（接口地址 / API key 未填）。
 */
export function llmDraftCredentials(
  draft: { baseUrl: string; apiKey: string },
  storedKey: string | undefined,
  seedKey: string | undefined,
): { baseUrl: string; apiKey: string } | string {
  const baseUrl = draft.baseUrl.trim();
  if (baseUrl === "") return "请先填写接口地址";
  const typedKey = draft.apiKey.trim();
  const apiKey = typedKey !== "" ? typedKey : storedKey !== undefined && storedKey !== "" ? storedKey : seedKey;
  if (apiKey === undefined || apiKey === "") return "请先填写 API key";
  return { baseUrl, apiKey };
}
