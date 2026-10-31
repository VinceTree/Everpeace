import en from './en.json' with { type: 'json' };
import zh from './zh-CN.json' with { type: 'json' };
import { currentLanguage, type UiLanguage } from './language.js';
export type UiMessageKey = keyof typeof en;
export const UI_CATALOGS = { en, 'zh-CN': zh };
export function displayStatus(value: unknown): string { const key = ('value.' + String(value).replaceAll('-', '_')) as UiMessageKey; return key in en ? uiText(key) : String(value); }
export function uiText(key: UiMessageKey, args: Readonly<Record<string, unknown>> = {}, language: UiLanguage = currentLanguage()): string {
    return UI_CATALOGS[language][key].replace(/\{(p\d+)\}/g, (_match, name: string) => String(args[name] ?? ''));
}
const patterns: Array<{
    key: UiMessageKey;
    language: UiLanguage;
    regex: RegExp;
    parameters: string[];
}> = [];
for (const language of ['en', 'zh-CN'] as const)
    for (const key of Object.keys(en) as UiMessageKey[]) {
        const text = UI_CATALOGS[language][key];
        const parameters: string[] = [];
        const chunks = text.split(/(\{p\d+\})/g);
        const pattern = chunks.map(chunk => { if (/^\{p\d+\}$/.test(chunk)) {
            parameters.push(chunk.slice(1, -1));
            return '([\\s\\S]*?)';
        } return chunk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('');
        if (text.trim())
            patterns.push({ key, language, regex: new RegExp('^' + pattern + '$'), parameters });
    }
/** Only call for host-owned UI state/history, never user, assistant, code or tool bodies. */
export function translateHostText(text: string): string {
    for (const pattern of patterns) {
        if (pattern.language === currentLanguage())
            continue;
        const match = pattern.regex.exec(text);
        if (match)
            return uiText(pattern.key, Object.fromEntries(pattern.parameters.map((name, i) => [name, match[i + 1] ?? ''])));
    }
    return text;
}
