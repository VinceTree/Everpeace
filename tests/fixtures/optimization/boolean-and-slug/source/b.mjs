export function transform(value) { return value.trim().toLowerCase().split(/\s+/).filter(Boolean).join('-'); }
