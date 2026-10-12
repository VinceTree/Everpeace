export function transform(value) { const slash=Math.max(value.lastIndexOf('/'),value.lastIndexOf('\\')); const dot=value.lastIndexOf('.'); return dot>slash?value.slice(0,dot):value; }
