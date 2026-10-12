import {uiText} from '../../localization/messages.js';
/** Previewed, conflict-aware Windows Terminal settings updates. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

export function terminalSettingsPath(): string {
  if (process.platform !== "win32" || !process.env.WT_SESSION || !process.env.LOCALAPPDATA) throw new Error(uiText('mce16a718d828'));
  return path.join(process.env.LOCALAPPDATA, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json");
}

export function prepareTerminalSettings(text: string): string {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) throw new Error(uiText('m579819b2e039'));
  for (const field of ["actions", "keybindings"]) {
    if (value[field] !== undefined && !Array.isArray(value[field])) throw new Error(uiText('m0e68a3276b74', {p0: field}));
    for (const binding of value[field] ?? []) {
      const keys = Array.isArray(binding.keys) ? binding.keys : [binding.keys];
      if (keys.some((key: unknown) => typeof key === "string" && key.toLowerCase().replace(/\s/g, "") === "shift+enter")) throw new Error(uiText('m6ffa58bc3346'));
    }
  }
  const action = { command: { action: "sendInput", input: "\n" }, id: "Everpeace.InsertNewline" };
  if ((value.actions ?? []).some((a: { id?: string }) => a.id === action.id)) throw new Error(uiText('m21dc3a99b7d4'));
  const options = { formattingOptions: { insertSpaces: true, tabSize: 4, eol: text.includes("\r\n") ? "\r\n" : "\n" } };
  let updated = value.actions === undefined ? applyEdits(text, modify(text, ["actions"], [], options)) : text;
  updated = applyEdits(updated, modify(updated, ["actions", -1], action, options));
  if (value.keybindings === undefined) updated = applyEdits(updated, modify(updated, ["keybindings"], [], options));
  updated = applyEdits(updated, modify(updated, ["keybindings", -1], { id: action.id, keys: "shift+enter" }, options));
  return updated;
}

export async function applyTerminalSettings(file: string, before: string, after: string): Promise<string> {
  if (await fs.readFile(file, "utf8") !== before) throw new Error(uiText('m41af6ac9db42'));
  const backup = `${file}.everpeace-${Date.now()}.bak`;
  await fs.writeFile(backup, before, { flag: "wx" });
  const temporary = `${backup}.tmp`;
  try {
    await fs.writeFile(temporary, after, { flag: "wx" });
    if (await fs.readFile(file, "utf8") !== before) throw new Error(uiText('m611c3d8cdf83'));
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
  return backup;
}
