import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyReadability } from '../scripts/readability.mjs';

function decodeClientFrame(buffer) {
  if ((buffer[0] & 0x0f) !== 1) return null;
  let offset = 2;
  let length = buffer[1] & 0x7f;
  if (length === 126) {
    length = buffer.readUInt16BE(offset);
    offset += 2;
  }
  const masked = Boolean(buffer[1] & 0x80);
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  return payload.toString('utf8');
}

function encodeServerFrame(value) {
  const payload = Buffer.from(value);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

async function fakeCdpServer() {
  const ids = [];
  const sockets = new Set();
  let port;
  const server = http.createServer((request, response) => {
    if (request.url === '/json/list') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify([{
        id: 'page-1',
        title: 'Codex',
        type: 'page',
        url: 'app://-/index.html',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-1`,
      }]));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'));
    socket.on('data', (data) => {
      const decoded = decodeClientFrame(data);
      if (!decoded) return;
      const message = JSON.parse(decoded);
      ids.push(message.id);
      const response = Number.isInteger(message.id) && message.id <= 0x7fffffff
        ? { id: message.id, result: { result: { type: 'string', value: 'complete' } } }
        : { error: { code: -32600, message: 'Message must have integer id property' } };
      socket.write(encodeServerFrame(JSON.stringify(response)));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  return { server, port, ids, sockets };
}

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
  assert.match(portable.css, /data:image\/png;base64,/);
  assert.doesNotMatch(portable.css, /url\("assets\/art\.png"\)/);

  const inlined = await skill.inlineLocalAssets(css, themeDir);
  assert.match(inlined, /data:image\/png;base64,/);
  assert.doesNotMatch(inlined, /url\("assets\/art\.png"\)/);

  const runtime = skill.runtimeSource('parity-test', 'home', inlined);
  assert.match(runtime, /codexskin-runtime-theme/);
  assert.match(runtime, /data-codexskin-page/);
  assert.match(runtime, /MutationObserver/);
  assert.match(runtime, /data-thread-find-target/);
  assert.match(runtime, /data-composer-navigation-target/);
  assert.match(runtime, /data-codexskin-surface/);
  assert.equal(skill.isThemeableAppTarget({ url: 'app://-/index.html' }), true);
  assert.equal(skill.isThemeableAppTarget({
    url: 'app://-/index.html?initialRoute=%2Fhotkey-window',
  }), false);
  assert.equal(skill.isThemeableAppTarget({
    url: 'app://-/index.html?initialRoute=%2Favatar-overlay',
  }), false);

  const parsed = skill.parseCliArgs(['switch', 'parity-test', '--launch', '--force', '--port', '9341']);
  assert.equal(parsed.argument, 'parity-test');
  assert.equal(parsed.options.launch, true);
  assert.equal(parsed.options.force, true);
  assert.equal(parsed.options.port, 9341);

  const readability = classifyReadability([
    { text: 'warning', ratio: 4.03, size: 14 },
    { text: 'critical one', ratio: 2.2, size: 14 },
  ]);
  assert.equal(readability.status, 'pass');
  assert.equal(readability.warnings.length, 1);
  assert.equal(readability.critical.length, 1);
  assert.equal(classifyReadability([
    { text: 'critical one', ratio: 2.2, size: 14 },
    { text: 'critical two', ratio: 2.1, size: 14 },
  ]).status, 'fail');

  const fake = await fakeCdpServer();
  try {
    const located = await skill.locateCdpTargets(fake.port);
    assert.equal(located.port, fake.port);
    assert.equal(located.targets.length, 1);
    const value = await skill.evaluateTarget(located.targets[0], 'document.readyState');
    assert.equal(value, 'complete');
    assert.ok(fake.ids.every((id) => Number.isInteger(id) && id > 0 && id <= 0x7fffffff));
  } finally {
    for (const socket of fake.sockets) socket.destroy();
    await new Promise((resolve) => fake.server.close(resolve));
  }

  assert.throws(
    () => skill.validatePackage({ ...portable, css: '@import "https://example.com/a.css";' }),
    /unsafe or external/i
  );
  assert.throws(
    () => skill.validatePackage({ ...portable, css: ':root[data-codexskin-theme="parity-test"] { background: url(//example.com/a.png); }' }),
    /unsafe or external/i
  );
  assert.throws(
    () => skill.validatePackage({
      ...portable,
      manifest: { ...portable.manifest, id: '../escape' },
    }),
    /id is unsafe/i
  );
  assert.throws(
    () => skill.validatePackage({ ...portable, css: ':root[data-codexthemes-theme="x"]{}' }),
    /foreign runtime marker/i
  );
  assert.throws(
    () => skill.validatePackage({
      ...portable,
      preview: { ...portable.preview, mimeType: 'image/jpeg' },
    }),
    /mismatched file signature/i
  );
  assert.throws(
    () => skill.validatePackage({
      ...portable,
      images: [{ ...portable.images[0], filename: '../escape.png' }],
    }),
    /path is unsafe/i
  );

  const listed = await skill.listThemes();
  assert.deepEqual(listed.map((item) => item.id), ['parity-test']);
  const inactive = await skill.statusTheme(false, { port: 9341, targets: [], skipped: [] });
  assert.equal(inactive.status, 'inactive');
  assert.equal(inactive.debugEndpoint, '127.0.0.1:9341');
  const restored = await skill.restoreTheme({ port: 9341, targets: [], skipped: [] });
  assert.equal(restored.status, 'inactive');
  assert.equal(restored.pagesRestored, 0);
  const rolledBack = await skill.rollbackTheme();
  assert.equal(rolledBack.status, 'native');
  console.log('CodexSkin lifecycle self-test passed.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
