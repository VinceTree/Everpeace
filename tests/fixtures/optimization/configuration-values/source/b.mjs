export function transform(value) { return value.split(',').map(v=>v.trim()).filter(Boolean); }
