import path from 'node:path';
export function within(root,target){const base=path.win32.resolve(root).toLowerCase().replace(/\\+$/u,'');const candidate=path.win32.resolve(target).toLowerCase();return candidate===base||candidate.startsWith(base+'\\');}
