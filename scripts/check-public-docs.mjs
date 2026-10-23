import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { maintainedFiles } from './maintained-files.mjs';
const files = maintainedFiles(['docs', '.github', 'README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'CONTRIBUTING.zh-CN.md', 'AGENTS.md', 'SECURITY.md'], /\.(?:md|json|ya?ml|txt|svg)$/u);
// Generic examples such as C:\projects and C:\workspace intentionally stay
// outside these patterns. User-home roots and machine evidence roots do not.
const privatePath = /(?:[A-Za-z]:(?:\\+|\/)Users(?:\\+|\/)[^\s`<>"']+|\/(?:home|Users)\/[A-Za-z0-9_.-]+(?:\/[^\s`<>"']*)?|[A-Za-z]:(?:\\+|\/)WSL(?:\\+|\/)[^\s`<>"']+)/u;
let failures = 0;
for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const [index, line] of text.split(/\r?\n/u).entries())
        if (privatePath.test(line)) {
            console.error(`${file}:${index + 1}: machine-specific path in public document`);
            failures++;
        }
    if (file.endsWith('.md'))
        for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
            const target = match[1].replace(/^<|>$/gu, '').split('#')[0];
            if (!target || /^(?:[a-z]+:|\/)/iu.test(target))
                continue;
            const resolved = path.resolve(path.dirname(file), target);
            if (!resolved.startsWith(process.cwd() + path.sep))
                throw Error('Documentation link escapes repository');
            try {
                await stat(resolved);
            }
            catch {
                console.error(`${file}: broken local link ${target}`);
                failures++;
            }
        }
}
if (failures)
    process.exitCode = 1;
else
    console.log(`Public document paths and local links verified: ${files.length} files.`);
