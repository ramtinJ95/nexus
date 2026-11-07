/** Orders strings by UTF-16 code unit, as `sort()` does, so the order is the same on every machine and locale. */
export const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
