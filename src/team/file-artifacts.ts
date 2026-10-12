import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const TEAM_FILE_LIMIT = 64 * 1024 * 1024;
export const TEAM_TOTAL_LIMIT = 256 * 1024 * 1024;
export interface FileArtifact { hash: string; size: number; identity: string }
function identity(s: {dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number}): string { return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }

export async function safeTeamPath(root: string, name: string, createParents = false): Promise<string> {
  if (!name || path.isAbsolute(name) || /[:\0]/u.test(name) || name.split(/[\\/]/u).some(p => !p || p === '..' || p === '.')) throw new Error('Unsafe team artifact path');
  const canonical = await fs.realpath(root);
  const target = path.join(canonical,name), relative=path.relative(canonical,target);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)) throw new Error('Team artifact escapes its root');
  let current=canonical;
  for(const component of name.split(/[\\/]/u)) {
    current=path.join(current,component);
    try { const stat=await fs.lstat(current); if(stat.isSymbolicLink() || current!==target&&!stat.isDirectory()) throw new Error('Team artifact traverses a link or non-directory'); }
    catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; if(createParents&&current!==target) { await fs.mkdir(current); const stat=await fs.lstat(current); if(stat.isSymbolicLink()||!stat.isDirectory()) throw new Error('Team artifact parent changed'); } }
  }
  return target;
}

export async function inspectTeamFile(root: string, name: string, signal?: AbortSignal): Promise<FileArtifact|null> {
  signal?.throwIfAborted();
  const target=await safeTeamPath(root,name);
  let before;
  try { before=await fs.lstat(target); } catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT') return null; throw error; }
  if(!before.isFile()||before.isSymbolicLink()||before.size>TEAM_FILE_LIMIT) throw new Error('Team artifact exceeds the 64 MiB file limit or is not ordinary');
  const handle=await fs.open(target,'r');
  try {
    if(identity(await handle.stat())!==identity(before)) throw new Error('Team artifact changed before read');
    const hash=createHash('sha256'); let size=0;
    for await(const chunk of handle.createReadStream({autoClose:false,highWaterMark:64*1024})) { signal?.throwIfAborted(); size+=(chunk as Buffer).length; if(size>TEAM_FILE_LIMIT) throw new Error('Team artifact grew beyond its limit'); hash.update(chunk as Buffer); }
    const after=await fs.lstat(target);
    if(after.isSymbolicLink()||size!==before.size||identity(after)!==identity(before)||await fs.realpath(target)!==target) throw new Error('Team artifact changed during read');
    return {hash:hash.digest('hex'),size,identity:identity(before)};
  } finally { await handle.close(); }
}

/** Destination must be a fresh ordinary file; writes never follow an existing link. */
export async function copyTeamFile(root: string, name: string, target: string, expected: FileArtifact, signal?: AbortSignal): Promise<void> {
  const source=await safeTeamPath(root,name), input=await fs.open(source,'r');
  let output: Awaited<ReturnType<typeof fs.open>>|undefined;
  try {
    if(identity(await input.stat())!==expected.identity) throw new Error('Team artifact changed before copy');
    output=await fs.open(target,'wx',0o600);
    const copiedHash=createHash('sha256');let copiedBytes=0;
    for await(const chunk of input.createReadStream({autoClose:false,highWaterMark:64*1024})) {signal?.throwIfAborted();copiedBytes+=(chunk as Buffer).length;if(copiedBytes>TEAM_FILE_LIMIT)throw new Error('Team artifact grew beyond copy limit');copiedHash.update(chunk as Buffer);await output.writeFile(chunk as Buffer);}
    if(copiedBytes!==expected.size||copiedHash.digest('hex')!==expected.hash)throw new Error('Copied artifact differs from the frozen bytes');
    await output.sync();
    const after=await inspectTeamFile(root,name,signal);
    if(!after||after.hash!==expected.hash||after.identity!==expected.identity) throw new Error('Team artifact changed during copy');
  } finally { await output?.close(); await input.close(); }
}
