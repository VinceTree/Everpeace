import {transform as text} from './a.mjs'; export function transform(value) { return text(value).replaceAll('"','&quot;').replaceAll("'",'&#39;'); }
