#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';

const command = process.argv[2];
const argument = process.argv[3];
const baseUrl = (process.env.CODEXSKIN_BASE_URL || 'https://codexskin.cool').replace(
  /\/$/,
  ''
);
const root = join(homedir(), '.codexskin');
const themesDir = join(root, 'themes');
const exportsDir = join(root, 'exports');
const stateDir = join(root, 'state');

const unsafeCss = [
  /@import/i,
  /url\s*\(\s*['"]?https?:/i,
  /javascript\s*:/i,
  /<script/i,
  /expression\s*\(/i,
];

function fail(message) {
  throw new Error(message);
}

function validatePackage(value) {
  if (
    value?.format !== 'codexskin-theme' ||
    value?.schemaVersion !== 1 ||
    typeof value?.manifest?.id !== 'string' ||
    typeof value?.manifest?.displayName !== 'string' ||
    typeof value?.manifest?.version !== 'string' ||
    typeof value?.css !== 'string'
  ) {
    fail('Unsupported or incomplete .codexskin-theme package.');
  }
  if (value.css.length > 1024 * 1024 || unsafeCss.some((rule) => rule.test(value.css))) {
    fail('Theme CSS contains an unsafe or external resource.');
  }
  return value;
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) fail(body.error || `${response.status} ${response.statusText}`);
  return body;
}

function authHeaders() {
  return process.env.CODEXSKIN_API_KEY
    ? { Authorization: `Bearer ${process.env.CODEXSKIN_API_KEY}` }
    : {};
}

async function findThemes(query = '') {
  const params = new URLSearchParams({ q: query, limit: '24' });
  const body = await fetchJson(`/api/themes?${params}`, {
    headers: authHeaders(),
  });
  for (const item of body.themes || []) {
    const type = item.kind === 'theme' ? 'THEME' : 'SKIN';
    const state = item.installable ? 'installable' : 'visual reference';
    console.log(`${type}\t${item.slug}\t${item.name}\t${state}`);
  }
}

async function installTheme(id) {
  if (!id) fail('Usage: install <theme-id-or-slug>');
  const detail = await fetchJson(`/api/themes/${encodeURIComponent(id)}`, {
    headers: authHeaders(),
  });
  const entry = detail.theme || detail.entry || detail;
  if (entry.kind !== 'theme' || !entry.installable) {
    fail('This entry is a Skin reference and is not installable.');
  }
  const response = await fetch(
    `${baseUrl}/api/themes/${encodeURIComponent(id)}/download`,
    { headers: authHeaders(), redirect: 'follow' }
  );
  if (!response.ok) fail(`Theme download failed: ${response.status}`);
  const text = await response.text();
  const packageData = validatePackage(JSON.parse(text));
  const idSafe = packageData.manifest.id.replace(/[^a-zA-Z0-9._-]/g, '-');
  const output = join(themesDir, idSafe);
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'package.codexskin-theme'), text, 'utf8');
  await writeFile(join(output, 'manifest.json'), JSON.stringify(packageData.manifest, null, 2));
  await writeFile(join(output, 'theme.css'), packageData.css, 'utf8');
  await writeFile(join(output, 'README.md'), packageData.readme || '', 'utf8');
  for (const [name, asset] of [
    ['art', packageData.art],
    ['preview', packageData.preview],
  ]) {
    if (!asset?.data || !asset?.mimeType) continue;
    const extension = asset.mimeType === 'image/png' ? 'png' : asset.mimeType === 'image/webp' ? 'webp' : 'jpg';
    await writeFile(join(output, `${name}.${extension}`), Buffer.from(asset.data, 'base64'));
  }
  console.log(`Installed ${packageData.manifest.displayName} at ${output}`);
}

async function createTheme(directory) {
  if (!directory) fail('Usage: create <theme-directory>');
  const input = resolve(directory);
  const manifest = JSON.parse(await readFile(join(input, 'manifest.json'), 'utf8'));
  const css = await readFile(join(input, 'theme.css'), 'utf8');
  const readme = await readFile(join(input, 'README.md'), 'utf8').catch(() => '');
  const files = await Promise.all(
    ['preview-1440x900.png', 'preview-1440x900.jpg', 'preview-1440x900.webp'].map(
      async (name) => ({ name, data: await readFile(join(input, name)).catch(() => null) })
    )
  );
  const preview = files.find((file) => file.data);
  if (!preview) fail('A 1440x900 PNG, JPG, or WebP preview is required.');
  const compactPreview = await Promise.all(
    ['preview-980x760.png', 'preview-980x760.jpg', 'preview-980x760.webp'].map((name) =>
      readFile(join(input, name)).catch(() => null)
    )
  );
  if (!compactPreview.some(Boolean)) fail('A 980x760 preview is required.');
  const mimeType = extname(preview.name) === '.png' ? 'image/png' : extname(preview.name) === '.webp' ? 'image/webp' : 'image/jpeg';
  const value = validatePackage({
    format: 'codexskin-theme',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    manifest,
    css,
    readme,
    preview: { mimeType, data: preview.data.toString('base64') },
    verification: {
      valid: true,
      externalResources: false,
      executableContent: false,
      previewSizes: ['1440x900', '980x760'],
      sha256: createHash('sha256').update(css).digest('hex'),
    },
  });
  await mkdir(exportsDir, { recursive: true });
  const output = join(exportsDir, `${manifest.id}.codexskin-theme`);
  await writeFile(output, JSON.stringify(value), 'utf8');
  console.log(`Created ${output}`);
}

async function cdpTarget() {
  const port = process.env.CODEXSKIN_CDP_PORT || '9341';
  const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
  if (!response?.ok) {
    fail(`Codex debugging endpoint is not available on 127.0.0.1:${port}. Do not restart Codex without permission.`);
  }
  const targets = await response.json();
  const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
  if (!target) fail('No debuggable Codex page target was found.');
  return target;
}

async function evaluate(expression) {
  const target = await cdpTarget();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const id = Date.now();
  const result = await new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => reject(new Error('Codex debugging request timed out.')), 10_000);
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timer);
      resolveResult(message);
    });
    socket.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true },
    }));
  });
  socket.close();
  if (result.error || result.result?.exceptionDetails) fail('Codex rejected the runtime style update.');
  return result.result?.result?.value;
}

async function readState() {
  return JSON.parse(await readFile(join(stateDir, 'current.json'), 'utf8').catch(() => '{}'));
}

async function switchTheme(id, preservePrevious = true) {
  if (!id) fail('Usage: switch <installed-theme-id>');
  const css = await readFile(join(themesDir, id, 'theme.css'), 'utf8');
  validatePackage({
    format: 'codexskin-theme',
    schemaVersion: 1,
    manifest: { id, displayName: id, version: 'local' },
    css,
  });
  const previous = await readState();
  const applied = await evaluate(`(() => {
    let style = document.getElementById('codexskin-runtime-theme');
    if (!style) { style = document.createElement('style'); style.id = 'codexskin-runtime-theme'; document.head.appendChild(style); }
    style.textContent = ${JSON.stringify(css)};
    document.documentElement.dataset.codexskinTheme = ${JSON.stringify(id)};
    return style.textContent.length > 0 && document.documentElement.dataset.codexskinTheme === ${JSON.stringify(id)};
  })()`);
  if (!applied) fail('Theme injection could not be verified.');
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, 'current.json'),
    JSON.stringify({ current: id, previous: preservePrevious ? previous.current || null : previous.previous || null, appliedAt: new Date().toISOString() }, null, 2)
  );
  console.log(`Applied and verified ${id}`);
}

async function restoreTheme() {
  await evaluate(`(() => {
    document.getElementById('codexskin-runtime-theme')?.remove();
    delete document.documentElement.dataset.codexskinTheme;
    return !document.getElementById('codexskin-runtime-theme');
  })()`);
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'current.json'), JSON.stringify({ current: null, previous: null, restoredAt: new Date().toISOString() }, null, 2));
  console.log('Restored the original Codex appearance.');
}

async function rollbackTheme() {
  const state = await readState();
  if (!state.previous) fail('No previous CodexSkin theme is recorded.');
  await switchTheme(state.previous, false);
}

async function submitTheme(packagePath) {
  if (!packagePath) fail('Usage: submit <package.codexskin-theme>');
  const value = validatePackage(JSON.parse(await readFile(resolve(packagePath), 'utf8')));
  if (!process.env.CODEXSKIN_API_KEY) {
    console.warn('No CODEXSKIN_API_KEY is configured. This will be an anonymous submission awaiting review.');
  }
  const body = await fetchJson('/api/themes/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      name: value.manifest.displayName,
      creator: value.manifest.author?.name || 'Community creator',
      description: value.readme || '',
      rightsConfirmed: true,
      package: value,
      previewBase64: value.preview
        ? `data:${value.preview.mimeType};base64,${value.preview.data}`
        : undefined,
    }),
  });
  console.log(`${body.status}: ${baseUrl}${body.url}`);
}

const commands = {
  find: () => findThemes(argument || ''),
  install: () => installTheme(argument),
  create: () => createTheme(argument),
  switch: () => switchTheme(argument),
  rollback: () => rollbackTheme(),
  restore: () => restoreTheme(),
  submit: () => submitTheme(argument),
};

if (!commands[command]) {
  console.log('Usage: codexskin.mjs <find|install|create|switch|rollback|restore|submit> [argument]');
  process.exit(command ? 1 : 0);
}

commands[command]().catch((error) => {
  console.error(`CodexSkin: ${error.message}`);
  process.exit(1);
});
