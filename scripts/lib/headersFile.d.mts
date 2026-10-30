// headersFile.mjs 的类型
export interface HeaderRule { pattern: string; re: RegExp; set: Array<[string, string]>; unset: string[] }
export function parseHeadersFile(text: string): HeaderRule[];
export function headersFor(rules: HeaderRule[], pathname: string): { set: Map<string, [string, string]>; unset: Set<string> };
