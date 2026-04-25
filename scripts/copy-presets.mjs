import {cpSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

cpSync(path.join(root, 'presets'), path.join(root, 'dist', 'presets'), {recursive: true});
console.log('Copied presets/ → dist/presets/');
