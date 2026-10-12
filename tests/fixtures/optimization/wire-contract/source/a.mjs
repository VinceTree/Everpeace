export const PREFIX='id:'; export function transform(value) { return Number.isSafeInteger(value)&&value>=0 ? PREFIX+value : null; }
