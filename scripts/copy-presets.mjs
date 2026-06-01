import {cpSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

cpSync(path.join(root, 'presets'), path.join(root, 'dist', 'presets'), {recursive: true});
console.log('Copied presets/ → dist/presets/');

cpSync(path.join(root, 'schema'), path.join(root, 'dist', 'schema'), {recursive: true});
console.log('Copied schema/ → dist/schema/');
