import {spawn} from 'child_process';

import {loadConfig} from '../config.js';
import {c, log} from '../util/log.js';

import {createServer} from './server.js';

const DEFAULT_PORT = 4310;
const DEFAULT_HOST = '127.0.0.1';

function getFlagValue(args: string[], flag: string): string | null {
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === flag && i + 1 < args.length) return args[i + 1];
        if (a.startsWith(flag + '=')) return a.slice(flag.length + 1);
    }
    return null;
}

/**
 * Returns a numeric exit code for validation failures. On success, boots the
 * server (which holds the event loop open) and returns `null` to tell the
 * caller not to call process.exit — that would kill the listening socket.
 */
export function runUi(args: string[], projectRoot: string): number | null {
    const portRaw = getFlagValue(args, '--port');
    const port = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_PORT;
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        log(`${c.red}error: --port must be 1..65535${c.reset}`);
        return 3;
    }
    const host = getFlagValue(args, '--host') ?? DEFAULT_HOST;
    const noOpen = args.includes('--no-open');

    const config = loadConfig(projectRoot);
    const sourceLocale =
        getFlagValue(args, '--source-locale') ??
        config.defaultLocale ??
        config.locales[0];

    if (!config.locales.includes(sourceLocale)) {
        log(`${c.red}error: source locale "${sourceLocale}" is not in config.locales [${config.locales.join(', ')}]${c.reset}`);
        return 3;
    }

    const server = createServer(config, {sourceLocale});

    server.on('error', err => {
        log(`${c.red}server error: ${err.message}${c.reset}`);
        process.exit(1);
    });

    server.listen(port, host, () => {
        const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
        log('');
        log(`${c.bold}Lexen UI${c.reset} — translator editor`);
        log('─'.repeat(50));
        log(`  ${c.cyan}${url}${c.reset}`);
        log(`  source locale: ${c.bold}${sourceLocale}${c.reset}  ${c.dim}(read-only reference)${c.reset}`);
        const targets = config.locales.filter(l => l !== sourceLocale);
        log(`  target locales: ${targets.length > 0 ? targets.join(', ') : c.dim + 'none' + c.reset}`);
        if (host === '0.0.0.0') {
            log(`  ${c.dim}listening on all interfaces — share via LAN or tunnel${c.reset}`);
        }
        log(`  ${c.dim}Ctrl-C to stop${c.reset}`);
        log('');

        if (!noOpen) {
            openBrowser(url);
        }
    });

    return null;
}

function openBrowser(url: string): void {
    const {platform} = process;
    let cmd: string;
    let args: string[];
    if (platform === 'win32') {
        // `start` is a cmd builtin; the empty "" is the window title.
        cmd = 'cmd';
        args = ['/c', 'start', '""', url];
    } else if (platform === 'darwin') {
        cmd = 'open';
        args = [url];
    } else {
        cmd = 'xdg-open';
        args = [url];
    }
    try {
        const child = spawn(cmd, args, {stdio: 'ignore', detached: true});
        child.on('error', () => {
            // Browser opener missing on this system — ignore silently. The user
            // already sees the URL printed above.
        });
        child.unref();
    } catch {
        // ignore — same rationale as above.
    }
}
