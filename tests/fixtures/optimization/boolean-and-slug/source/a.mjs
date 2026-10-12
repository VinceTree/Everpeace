export function transform(value) { const v=value.trim().toLowerCase();return ['true','yes','1'].includes(v)?true:['false','no','0'].includes(v)?false:null; }
