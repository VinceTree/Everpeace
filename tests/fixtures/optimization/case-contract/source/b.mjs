import {transform as normalize} from './a.mjs'; export function transform(value) { const key=normalize(value); return {key,valid:key.length>0}; }
