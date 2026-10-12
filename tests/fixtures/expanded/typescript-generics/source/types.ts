export type Flatten<T> = T extends readonly (infer U)[] ? U : T;
export type Wrapped<T> = T extends unknown ? {value:T} : never;
export function echo(value:string):string;
export function echo(value:number):number;
export function echo(value:string|number):string|number{return value;}
