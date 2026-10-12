export function transform(value) { return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
