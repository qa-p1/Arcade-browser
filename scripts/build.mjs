#!/usr/bin/env node
// Builds dist/chromium and dist/firefox: the bundled scripts, the pages, the Arcade kit's stylesheet, font and
// icons, and each browser's manifest.
//
//   node scripts/build.mjs                 # both
//   node scripts/build.mjs --target firefox

import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest, MINIMUM } from '../src/manifest.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const only = args.includes('--target') ? args[args.indexOf('--target') + 1] : null;
const targets = only ? [only] : ['chromium', 'firefox'];

for (const target of targets) {
  if (!['chromium', 'firefox'].includes(target)) throw new Error(`unknown target ${target}`);
  const out = join(root, 'dist', target);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: { background: 'src/background.ts', form: 'src/pages/form.ts', popup: 'src/pages/popup.ts' },
    absWorkingDir: root,
    outdir: out,
    bundle: true,
    format: 'iife',
    target: target === 'chromium' ? `chrome${MINIMUM.chromium}` : `firefox${MINIMUM.firefox.split('.')[0]}`,
    define: { __TARGET__: JSON.stringify(target) },
    legalComments: 'none',
    logLevel: 'warning',
  });
  for (const page of ['form.html', 'popup.html', 'pages.css']) cpSync(join(root, 'src/pages', page), join(out, page));
  cpSync(join(root, 'design/arcade.css'), join(out, 'design/arcade.css'));
  cpSync(join(root, 'design/fonts/InterVariable.woff2'), join(out, 'fonts/InterVariable.woff2'));
  cpSync(join(root, 'design/fonts/OFL.txt'), join(out, 'fonts/OFL.txt'));
  cpSync(join(root, 'design/icons'), join(out, 'icons'), { recursive: true });
  for (const license of ['LICENSE-MIT', 'LICENSE-APACHE']) cpSync(join(root, license), join(out, license));
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest(target, pkg.version), null, 2) + '\n');
  console.log(`built dist/${target} (${pkg.version})`);
}
