import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'docs', '.github', 'README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'CONTRIBUTING.zh-CN.md', 'AGENTS.md', 'SECURITY.md'], { encoding: 'utf8' }).split('\0'))].filter(file => /\.(?:md|json|ya?ml|txt|svg)$/u.test(file));
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
