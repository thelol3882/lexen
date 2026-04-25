export const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
} as const;

export type Color = (typeof c)[keyof typeof c] | '';

export function log(msg: string, color: Color = ''): void {
    console.log(`${color}${msg}${c.reset}`);
}
