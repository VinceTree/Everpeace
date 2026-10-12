export function transform(value) { const s=value.trim();if(!/^\d+$/.test(s))return null;const n=Number(s);return Number.isSafeInteger(n)?n:null; }
