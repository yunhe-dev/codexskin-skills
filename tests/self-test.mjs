import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = await mkdtemp(join(tmpdir(), 'codexskin-skills-'));
process.env.CODEXSKIN_HOME = temp;
const skill = await import(`../scripts/codexskin.mjs?test=${Date.now()}`);

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

try {
  const themeDir = join(temp, 'themes', 'parity-test');
  await mkdir(join(themeDir, 'assets'), { recursive: true });
  await mkdir(join(themeDir, 'previews'), { recursive: true });
  const manifest = {
    schemaVersion: 1,
    id: 'parity-test',
    displayName: 'Parity Test',
    description: 'A controlled lifecycle test theme.',
    version: '1.0.0',
    mode: 'dark',
    css: 'theme.css',
    art: 'assets/art.png',
    design: {
      layoutMode: 'native-immersive',
      backgroundScope: 'home',
      decorDensity: 'balanced',
      verificationViewports: ['1440x900', '980x760']
    }
  };
  const css = ':root[data-codexskin-theme="parity-test"] { --accent: #7487ff; background-image: url("assets/art.png"); }';
  await writeFile(join(themeDir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(themeDir, 'theme.css'), css);
  await writeFile(join(themeDir, 'README.md'), 'Controlled parity fixture.');
  await writeFile(join(themeDir, 'assets', 'art.png'), png);
  await writeFile(join(themeDir, 'previews', 'preview-1440x900.png'), png);
  await writeFile(join(themeDir, 'previews', 'preview-980x760.png'), png);

  const validation = await skill.validateThemeDirectory(themeDir);
  assert.equal(validation.manifest.id, 'parity-test');

  const packagePath = await skill.createTheme(themeDir);
  const portable = JSON.parse(await readFile(packagePath, 'utf8'));
  assert.equal(portable.format, 'codexskin-theme');
  assert.equal(portable.preview.filename, 'previews/preview-1440x900.png');
  assert.equal(portable.images[0].filename, 'previews/preview-980x760.png');
  assert.equal(portable.art.filename, 'assets/art.png');

  const inlined = await skill.inlineLocalAssets(css, themeDir);
  assert.match(inlined, /data:image\/png;base64,/);
  assert.doesNotMatch(inlined, /url\("assets\/art\.png"\)/);

  const runtime = skill.runtimeSource('parity-test', 'home', inlined);
  assert.match(runtime, /codexskin-runtime-theme/);
  assert.match(runtime, /data-codexskin-page/);
  assert.match(runtime, /MutationObserver/);
  assert.match(runtime, /data-thread-find-target/);
  assert.match(runtime, /data-composer-navigation-target/);

  assert.throws(
    () => skill.validatePackage({ ...portable, css: '@import "https://example.com/a.css";' }),
    /unsafe or external/i
  );
  assert.throws(
    () => skill.validatePackage({ ...portable, css: ':root[data-codexthemes-theme="x"]{}' }),
    /foreign runtime marker/i
  );

  const listed = await skill.listThemes();
  assert.deepEqual(listed.map((item) => item.id), ['parity-test']);
  console.log('CodexSkin lifecycle self-test passed.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
