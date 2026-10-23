import { isLanguagePreference, type LanguagePreference } from '../localization/language.js';
import { CliArgumentError } from './args.js';
export function presentationArgs(input: readonly string[]): {
    args: string[];
    language?: LanguagePreference;
    accessible: boolean;
} {
    const args: string[] = [];
    let language: LanguagePreference | undefined, accessible = false, options = true;
    for (let i = 0; i < input.length; i++) {
        const value = input[i]!;
        if (value === '--') {
            options = false;
            args.push(value);
            continue;
        }
        if (options && value === '--lang') {
            if (language !== undefined)
                throw new CliArgumentError('--lang may only be specified once');
            const next = input[++i];
            if (!isLanguagePreference(next))
                throw new CliArgumentError('--lang requires auto, en or zh-CN');
            language = next;
        }
        else if (options && value === '--accessible') {
            if (accessible)
                throw new CliArgumentError('--accessible may only be specified once');
            accessible = true;
        }
        else
            args.push(value);
    }
    return { args, ...(language ? { language } : {}), accessible };
}
