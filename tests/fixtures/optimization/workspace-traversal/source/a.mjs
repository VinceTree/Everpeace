export function transform(value) { return !value||value.startsWith('/')||value.includes(':')||value.includes('\\')||value.split('/').includes('..')?null:value; }
