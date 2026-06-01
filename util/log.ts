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

let quiet = false;
/** When true, ALL log output is suppressed (used for machine-readable formats). */
let silent = false;

export function setQuiet(v: boolean): void {
    quiet = v;
}

/** Suppress ALL log/logDetail output — for machine-readable format renderers. */
export function setSilent(v: boolean): void {
    silent = v;
}

export function log(msg: string, color: Color = ''): void {
    if (silent) return;
    console.log(`${color}${msg}${c.reset}`);
}

export function logDetail(msg: string, color: Color = ''): void {
    if (!quiet) log(msg, color);
}
