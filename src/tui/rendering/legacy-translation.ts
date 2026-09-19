/** Display-only translations for legacy persisted UI chrome. */
const EXACT_TRANSLATIONS: Readonly<Record<string, string>> = {
  "新 Session": "New Session",
  "尚未启用模型，请先使用 /login 或 /model。": "No model is active. Use /login or /model first.",
  "模型请求已取消。": "Model request cancelled.",
  "已创建新 Session；发送第一条消息后会自动生成名称。": "New session created. Its title will be generated after your first message.",
  "当前没有可用模型，请使用 /login。": "No models are available. Use /login first.",
};

export function translateLegacyUiText(value: string): string {
  const exact = EXACT_TRANSLATIONS[value];
  if (exact) return exact;

  const replacements: Array<[RegExp, string]> = [
    [/^搜索网页：/u, "Searching the web: "],
    [/^读取网页：/u, "Reading web page: "],
    [/^文件工具：/u, "File tool: "],
    [/^已启用模型 (.+)；对话上下文已重置。$/u, "Enabled model $1; conversation context was reset."],
    [/^已登录并启用 (.+)；对话上下文已重置。$/u, "Signed in and enabled $1; conversation context was reset."],
    [/^已自动切换到 (.+)；对话上下文已重置。$/u, "Automatically switched to $1; conversation context was reset."],
    [/^已删除 (\d+) 个模型及对应系统凭据。$/u, "Removed $1 models and associated system credentials."],
    [/^已启用模型 (.+)$/u, "Enabled model $1"],
    [/^已登录并启用 (.+)$/u, "Signed in and enabled $1"],
    [/^凭据缺失：(.+)，请使用 \/login 修复或 \/logout 删除。$/u, "Missing credentials for $1. Use /login to repair or /logout to remove it."],
  ];
  for (const [pattern, replacement] of replacements) {
    if (pattern.test(value)) return value.replace(pattern, replacement);
  }
  return value;
}
