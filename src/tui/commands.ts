export const SLASH_COMMANDS = [
  "/login",
  "/model",
  "/models",
  "/new",
  "/resume",
  "/logout",
  "/clear",
  "/help",
  "/exit",
] as const;

export type SlashCommand = (typeof SLASH_COMMANDS)[number];

export type ParsedTuiInput =
  | { kind: "empty" }
  | { kind: "chat"; text: string }
  | { kind: "bash"; command: string }
  | { kind: "slash"; command: SlashCommand }
  | { kind: "unknown"; command: string };

function isSlashCommand(value: string): value is SlashCommand {
  return (SLASH_COMMANDS as readonly string[]).includes(value);
}

export function parseTuiInput(input: string): ParsedTuiInput {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "empty" };
  if (trimmed.startsWith("!")) {
    return { kind: "bash", command: trimmed.slice(1).trimStart() };
  }
  if (trimmed.startsWith("/")) {
    const command = trimmed.split(/\s+/, 1)[0]!.toLowerCase();
    return isSlashCommand(command)
      ? { kind: "slash", command }
      : { kind: "unknown", command };
  }
  return { kind: "chat", text: trimmed };
}

export const TUI_HELP = `斜杠命令
  /login   登录并立即启用一个模型
  /model   切换已登录模型
  /models  查看模型及凭据状态
  /new     立即创建并进入新 Session
  /resume  查看并恢复本机 Session
  /logout  删除模型和对应系统凭据
  /clear   结束当前对话，下一次提问创建新 Session
  /help    显示帮助
  /exit    退出 Everpeace

直接 Bash
  !<command>  直接执行命令，不再确认`;
