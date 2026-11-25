import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * electron-builder only writes `latest.yml` when a publish provider is
 * configured. Nest ships with a user-selectable generic feed instead, so the
 * manifest is generated here from the NSIS installer that was just built.
 *
 * Usage: node scripts/make-latest-yml.mjs [output-dir]
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.resolve(process.argv[2] ?? path.join(root, 'apps', 'desktop', 'release'));
const desktopPackage = JSON.parse(
  readFileSync(path.join(root, 'apps', 'desktop', 'package.json'), 'utf8'),
);

if (!existsSync(outputDir)) {
  throw new Error(`Output directory does not exist: ${outputDir}`);
}

const expected = `Nest-Setup-${desktopPackage.version}.exe`;
const installer =
  readdirSync(outputDir).find((name) => name === expected) ??
  readdirSync(outputDir).find(
    (name) => /^Nest-Setup-.*\.exe$/.test(name) && !name.includes('__uninstaller'),
  );
if (!installer) {
  throw new Error(`No Nest-Setup-*.exe found in ${outputDir}`);
}

const filePath = path.join(outputDir, installer);
const contents = readFileSync(filePath);
const sha512 = createHash('sha512').update(contents).digest('base64');
const releaseDate = new Date().toISOString();

const manifest = [
  `version: ${desktopPackage.version}`,
  'files:',
  `  - url: ${installer}`,
  `    sha512: ${sha512}`,
  `    size: ${contents.length}`,
  `path: ${installer}`,
  `sha512: ${sha512}`,
  `releaseDate: '${releaseDate}'`,
  '',
].join('\n');

const target = path.join(outputDir, 'latest.yml');
writeFileSync(target, manifest, 'utf8');
console.log(`Wrote ${target} for ${installer} (${desktopPackage.version})`);
