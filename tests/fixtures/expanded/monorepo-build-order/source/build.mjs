import {readdir,readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
export async function build(root){ const names=(await readdir(root+'/packages')).sort(); const built={}; for(const name of names){ const manifest=JSON.parse(await readFile(root+'/packages/'+name+'/package.json','utf8')); const module=await import(pathToFileURL(root+'/packages/'+name+'/index.mjs').href); const deps=Object.keys(manifest.dependencies??{}).map(dep=>{if(!(dep in built))throw new Error('dependency not built: '+dep);return built[dep]});built[manifest.name]=module.build(deps); } return built; }
