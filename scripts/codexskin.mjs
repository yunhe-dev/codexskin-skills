#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const command = process.argv[2];
const argument = process.argv[3];
const baseUrl = (
  process.env.CODEXSKIN_API_BASE ||
  process.env.CODEXSKIN_BASE_URL ||
  'https://codexskin.cool'
).replace(/\/$/, '');
const root = resolve(process.env.CODEXSKIN_HOME || join(homedir(), '.codexskin'));
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

export function fail(message) {
  throw new Error(message);
}

export function validatePackage(value) {
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
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(value.manifest.id)) {
    fail('Theme id is unsafe.');
  }
  if (value.css.length > 1024 * 1024 || unsafeCss.some((rule) => rule.test(value.css))) {
    fail('Theme CSS contains an unsafe or external resource.');
  }
  if (/codexthemes/i.test(value.css)) {
    fail('Theme CSS contains a foreign runtime marker; use CodexSkin-owned markers.');
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 30 * 1024 * 1024) {
    fail('Portable theme package exceeds 30 MB.');
  }
  if (/([A-Za-z]:\\|\/(?:Users|home|private|tmp)\/)/.test(serialized)) {
    fail('Portable theme package contains an absolute or private path.');
  }
  return value;
}

function mimeFor(filename) {
  const extension = extname(filename).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  fail(`Unsupported image type: ${extension || filename}`);
}

function extensionFor(mimeType) {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/jpeg') return 'jpg';
  fail(`Unsupported image MIME type: ${mimeType}`);
}

function validateImageBytes(bytes, mimeType) {
  const hex = bytes.subarray(0, 12).toString('hex');
  const valid =
    (mimeType === 'image/png' && hex.startsWith('89504e470d0a1a0a')) ||
    (mimeType === 'image/jpeg' && hex.startsWith('ffd8ff')) ||
    (mimeType === 'image/webp' && hex.startsWith('52494646') && hex.slice(16, 24) === '57454250');
  if (!valid) fail(`Embedded ${mimeType} asset has a mismatched file signature.`);
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

export async function findThemes(query = '') {
  const params = new URLSearchParams({ q: query, limit: '5' });
  const body = await fetchJson(`/api/themes?${params}`, {
    headers: authHeaders(),
  });
  for (const item of (body.themes || []).slice(0, 5)) {
    const type = item.kind === 'theme' ? 'THEME' : 'SKIN';
    const state = item.installable ? 'installable' : 'visual reference';
    const url = item.url?.startsWith('http')
      ? item.url
      : `${baseUrl}${item.url || `/${item.kind === 'skin' ? 'skins' : 'themes'}/${item.slug}`}`;
    console.log(
      [type, item.slug, item.name, item.authorName || item.creator || 'Unknown', state, url].join('\t')
    );
  }
}

async function writeEmbeddedAsset(output, fallbackName, asset) {
  if (!asset?.data || !asset?.mimeType) return null;
  const bytes = Buffer.from(asset.data, 'base64');
  validateImageBytes(bytes, asset.mimeType);
  const safeName = String(asset.filename || fallbackName).replace(/[^a-zA-Z0-9._-]/g, '-');
  const expectedExtension = extensionFor(asset.mimeType);
  const filename = extname(safeName) ? safeName : `${safeName}.${expectedExtension}`;
  const destination = join(output, filename);
  if (relative(output, destination).startsWith('..')) fail('Embedded asset path escapes the theme directory.');
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  return filename;
}

export async function installTheme(id) {
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
  await writeEmbeddedAsset(output, 'art', packageData.art);
  await writeEmbeddedAsset(output, 'preview', packageData.preview);
  for (const asset of packageData.images || []) {
    await writeEmbeddedAsset(output, 'image', asset);
  }
  console.log(`Installed ${packageData.manifest.displayName} at ${output}. It is not active yet; use the switcher after approval.`);
}

async function firstExisting(input, names) {
  for (const name of names) {
    const filename = join(input, name);
    const data = await readFile(filename).catch(() => null);
    if (data) return { filename, name, data };
  }
  return null;
}

export async function validateThemeDirectory(directory) {
  const input = resolve(directory);
  const manifest = JSON.parse(await readFile(join(input, 'manifest.json'), 'utf8'));
  const css = await readFile(join(input, manifest.css || 'theme.css'), 'utf8');
  validatePackage({
    format: 'codexskin-theme',
    schemaVersion: 1,
    manifest,
    css,
  });
  const viewports = manifest.design?.verificationViewports || [];
  if (!viewports.includes('1440x900') || !viewports.includes('980x760')) {
    fail('Manifest design.verificationViewports must include 1440x900 and 980x760.');
  }
  if (!['home', 'workspace'].includes(manifest.design?.backgroundScope)) {
    fail('Manifest design.backgroundScope must be home or workspace.');
  }
  if (!css.includes(`data-codexskin-theme="${manifest.id}"`)) {
    fail('Theme CSS must be scoped to its data-codexskin-theme marker.');
  }
  const desktop = await firstExisting(input, [
    'preview-1440x900.png',
    'preview-1440x900.jpg',
    'preview-1440x900.webp',
    'previews/preview-1440x900.png',
    'previews/preview-1440x900.jpg',
    'previews/preview-1440x900.webp',
    'previews/home-1440x900.png',
    'previews/home-1440x900.jpg',
    'previews/home-1440x900.webp',
  ]);
  const compact = await firstExisting(input, [
    'preview-980x760.png',
    'preview-980x760.jpg',
    'preview-980x760.webp',
    'previews/preview-980x760.png',
    'previews/preview-980x760.jpg',
    'previews/preview-980x760.webp',
    'previews/home-980x760.png',
    'previews/home-980x760.jpg',
    'previews/home-980x760.webp',
  ]);
  if (!desktop) fail('A full-workspace 1440x900 preview is required.');
  if (!compact) fail('A full-workspace 980x760 preview is required.');
  validateImageBytes(desktop.data, mimeFor(desktop.name));
  validateImageBytes(compact.data, mimeFor(compact.name));
  return { input, manifest, css, desktop, compact };
}

export async function createTheme(directory) {
  if (!directory) fail('Usage: create <theme-directory>');
  const { input, manifest, css, desktop, compact } = await validateThemeDirectory(directory);
  const readme = await readFile(join(input, 'README.md'), 'utf8').catch(() => '');
  const artRelative = manifest.art;
  let art;
  if (typeof artRelative === 'string') {
    if (isAbsolute(artRelative) || artRelative.split(/[\\/]/).includes('..')) {
      fail('Manifest artwork path is unsafe.');
    }
    const artBytes = await readFile(join(input, artRelative));
    const artMime = mimeFor(artRelative);
    validateImageBytes(artBytes, artMime);
    art = {
      filename: artRelative,
      mimeType: artMime,
      data: artBytes.toString('base64'),
    };
  }
  const value = validatePackage({
    format: 'codexskin-theme',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    manifest,
    css,
    readme,
    ...(art ? { art } : {}),
    preview: {
      filename: desktop.name,
      mimeType: mimeFor(desktop.name),
      data: desktop.data.toString('base64'),
    },
    images: [
      {
        filename: compact.name,
        mimeType: mimeFor(compact.name),
        data: compact.data.toString('base64'),
      },
    ],
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
  await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  console.log(`Created ${output}`);
  return output;
}

async function targetsAt(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(1000),
  }).catch(() => null);
  if (!response?.ok) return [];
  const targets = await response.json();
  return targets.filter(
    (item) =>
      item.type === 'page' &&
      item.webSocketDebuggerUrl &&
      (!item.url || item.url.startsWith('app://'))
  );
}

export async function cdpTargets() {
  const preferred = Number(process.env.CODEXSKIN_CDP_PORT || '9341');
  for (const port of [...new Set([preferred, 9335, 9222, 9223])]) {
    const targets = await targetsAt(port);
    if (targets.length > 0) return { port, targets };
  }
  fail(
    `Codex debugging endpoint is not available on 127.0.0.1:${preferred}. Do not restart Codex without permission.`
  );
}

async function sendCdp(target, method, params = {}) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const id = Date.now() + Math.floor(Math.random() * 1000);
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
      method,
      params,
    }));
  });
  socket.close();
  if (result.error || result.result?.exceptionDetails) {
    fail(`Codex rejected ${method}.`);
  }
  return result.result;
}

async function evaluateTarget(target, expression) {
  const result = await sendCdp(target, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  return result?.result?.value;
}

export async function inlineLocalAssets(css, themeDir) {
  const matches = [...css.matchAll(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi)];
  let output = css;
  for (const match of matches) {
    const source = match[2].trim();
    if (/^(data:|https?:|#)/i.test(source)) {
      if (/^https?:/i.test(source)) fail(`External CSS asset is not allowed: ${source}`);
      continue;
    }
    const absolute = resolve(themeDir, source);
    if (relative(themeDir, absolute).startsWith('..')) {
      fail(`CSS asset escapes the theme directory: ${source}`);
    }
    const bytes = await readFile(absolute);
    const mimeType = mimeFor(absolute);
    validateImageBytes(bytes, mimeType);
    output = output.replaceAll(match[0], `url("data:${mimeType};base64,${bytes.toString('base64')}")`);
  }
  return output;
}

export function runtimeSource(id, backgroundScope, css) {
  return `(() => {
    window.__codexskinRuntime?.dispose?.();
    const style = document.createElement('style');
    style.id = 'codexskin-runtime-theme';
    style.dataset.codexskinOwned = 'true';
    style.textContent = ${JSON.stringify(css)};
    (document.head || document.documentElement).appendChild(style);
    const update = () => {
      const root = document.documentElement;
      root.dataset.codexskinTheme = ${JSON.stringify(id)};
      root.dataset.codexskinBackgroundScope = ${JSON.stringify(backgroundScope)};
      document.querySelectorAll('main.main-surface').forEach((main) => {
        const conversation = main.querySelector('[data-thread-find-target="conversation"], [data-thread-user-message-navigation-item-id]');
        const home = main.querySelector('section[class~="group/home-suggestions"], [data-composer-navigation-target="workspace-project"], [data-testid="prompt-suggestion"]');
        main.dataset.codexskinPage = conversation ? 'conversation' : home ? 'home' : 'system';
      });
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.__codexskinRuntime = {
      id: ${JSON.stringify(id)},
      dispose() {
        observer.disconnect();
        document.getElementById('codexskin-runtime-theme')?.remove();
        delete document.documentElement.dataset.codexskinTheme;
        delete document.documentElement.dataset.codexskinBackgroundScope;
        document.querySelectorAll('[data-codexskin-page]').forEach((node) => delete node.dataset.codexskinPage);
        delete window.__codexskinRuntime;
      }
    };
    return style.textContent.length > 0 && document.documentElement.dataset.codexskinTheme === ${JSON.stringify(id)};
  })()`;
}

async function readState() {
  return JSON.parse(await readFile(join(stateDir, 'current.json'), 'utf8').catch(() => '{}'));
}

export async function listThemes() {
  const entries = await readdir(themesDir, { withFileTypes: true }).catch(() => []);
  const themes = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(await readFile(join(themesDir, entry.name, 'manifest.json'), 'utf8'));
      themes.push({ id: manifest.id, name: manifest.displayName, version: manifest.version });
    } catch {
      // Ignore non-theme directories.
    }
  }
  for (const theme of themes.sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(`${theme.id}\t${theme.name}\t${theme.version}`);
  }
  return themes;
}

export async function switchTheme(id, preservePrevious = true) {
  if (!id) fail('Usage: switch <installed-theme-id>');
  const themeDir = join(themesDir, id);
  const manifest = JSON.parse(await readFile(join(themeDir, 'manifest.json'), 'utf8'));
  const css = await inlineLocalAssets(
    await readFile(join(themeDir, manifest.css || 'theme.css'), 'utf8'),
    themeDir
  );
  validatePackage({
    format: 'codexskin-theme',
    schemaVersion: 1,
    manifest,
    css,
  });
  const previous = await readState();
  const located = await cdpTargets();
  const source = runtimeSource(id, manifest.design?.backgroundScope || 'home', css);
  const registrations = [];
  for (const target of located.targets) {
    const oldRegistration = (previous.registrations || []).find(
      (item) => item.targetId === target.id
    );
    if (oldRegistration?.identifier) {
      await sendCdp(target, 'Page.removeScriptToEvaluateOnNewDocument', {
        identifier: oldRegistration.identifier,
      }).catch(() => undefined);
    }
    const registration = await sendCdp(target, 'Page.addScriptToEvaluateOnNewDocument', { source });
    const applied = await evaluateTarget(target, source);
    if (!applied) fail(`Theme injection could not be verified for ${target.title || target.id}.`);
    registrations.push({ targetId: target.id, identifier: registration.identifier });
  }
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, 'current.json'),
    JSON.stringify({
      current: id,
      previous: preservePrevious ? previous.current || null : previous.previous || null,
      port: located.port,
      registrations,
      appliedAt: new Date().toISOString(),
    }, null, 2)
  );
  const status = await statusTheme(false);
  if (status.status !== 'active' || status.themeId !== id) {
    fail('Theme injection marker did not survive the status check.');
  }
  console.log(`Applied and DOM-verified ${id} on ${status.pages} Codex page(s). Run audit before visual signoff.`);
  return status;
}

export async function statusTheme(log = true) {
  const located = await cdpTargets();
  const results = [];
  for (const target of located.targets) {
    results.push(await evaluateTarget(target, `(() => ({
      active: Boolean(document.getElementById('codexskin-runtime-theme')),
      themeId: document.documentElement.dataset.codexskinTheme || null,
      pageMarkers: document.querySelectorAll('[data-codexskin-page]').length
    }))()`));
  }
  const ids = [...new Set(results.filter((item) => item.active).map((item) => item.themeId))];
  const active = results.length > 0 && results.every((item) => item.active) && ids.length === 1;
  const status = { status: active ? 'active' : 'inactive', themeId: active ? ids[0] : null, pages: results.length, results };
  if (log) console.log(JSON.stringify(status, null, 2));
  return status;
}

export async function auditTheme() {
  const located = await cdpTargets();
  const results = [];
  const auditExpression = `(() => {
    const parse = (value) => {
      const match = value.match(/rgba?\\((\\d+)[, ]+(\\d+)[, ]+(\\d+)(?:[, /]+([\\d.]+))?\\)/);
      return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])] : null;
    };
    const lum = ([r,g,b]) => [r,g,b].map((v) => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, index) => sum + v * [.2126,.7152,.0722][index], 0);
    const ratio = (a,b) => { const x = lum(a), y = lum(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
    const visible = [...document.querySelectorAll('body *')].filter((node) => {
      const style = getComputedStyle(node); const rect = node.getBoundingClientRect();
      return node.childElementCount === 0 && node.textContent?.trim() && rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > .05;
    }).slice(0, 400);
    const failures = [];
    for (const node of visible) {
      const fg = parse(getComputedStyle(node).color); if (!fg || fg[3] < .5) continue;
      let parent = node; let bg = null;
      while (parent && !bg) { const color = parse(getComputedStyle(parent).backgroundColor); if (color && color[3] >= .9) bg = color; parent = parent.parentElement; }
      if (!bg) continue;
      const score = ratio(fg, bg); const size = parseFloat(getComputedStyle(node).fontSize);
      if (score < (size >= 24 ? 3 : 4.5)) failures.push({ text: node.textContent.trim().slice(0,80), ratio: Number(score.toFixed(2)) });
    }
    return { themeId: document.documentElement.dataset.codexskinTheme || null, samples: visible.length, failures: failures.slice(0,20) };
  })()`;
  for (const target of located.targets) results.push(await evaluateTarget(target, auditExpression));
  const report = { status: results.every((item) => item.failures.length === 0) ? 'pass' : 'fail', pages: results.length, results };
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'fail') process.exitCode = 1;
  return report;
}

export async function restoreTheme() {
  const state = await readState();
  const located = await cdpTargets();
  for (const target of located.targets) {
    const registration = (state.registrations || []).find((item) => item.targetId === target.id);
    if (registration?.identifier) {
      await sendCdp(target, 'Page.removeScriptToEvaluateOnNewDocument', {
        identifier: registration.identifier,
      }).catch(() => undefined);
    }
    const restored = await evaluateTarget(target, `(() => {
      window.__codexskinRuntime?.dispose?.();
      document.getElementById('codexskin-runtime-theme')?.remove();
      delete document.documentElement.dataset.codexskinTheme;
      delete document.documentElement.dataset.codexskinBackgroundScope;
      document.querySelectorAll('[data-codexskin-page]').forEach((node) => delete node.dataset.codexskinPage);
      return !document.getElementById('codexskin-runtime-theme') && !document.documentElement.dataset.codexskinTheme;
    })()`);
    if (!restored) fail(`Native appearance could not be verified for ${target.title || target.id}.`);
  }
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'current.json'), JSON.stringify({ current: null, previous: null, restoredAt: new Date().toISOString() }, null, 2));
  console.log(`Restored and DOM-verified the original Codex appearance on ${located.targets.length} page(s).`);
}

export async function rollbackTheme() {
  const state = await readState();
  if (!state.previous) fail('No previous CodexSkin theme is recorded.');
  await switchTheme(state.previous, false);
}

export async function submitTheme(packagePath) {
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
  export: () => createTheme(argument),
  validate: async () => {
    const result = await validateThemeDirectory(argument);
    console.log(`Valid CodexSkin theme: ${result.manifest.id}`);
  },
  list: () => listThemes(),
  switch: () => switchTheme(argument),
  apply: () => switchTheme(argument),
  status: () => statusTheme(),
  audit: () => auditTheme(),
  rollback: () => rollbackTheme(),
  restore: () => restoreTheme(),
  submit: () => submitTheme(argument),
};

async function main() {
  if (!commands[command]) {
    console.log('Usage: codexskin.mjs <find|install|validate|create|list|switch|status|audit|rollback|restore|submit> [argument]');
    process.exitCode = command ? 1 : 0;
    return;
  }
  await commands[command]();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`CodexSkin: ${error.message}`);
    process.exitCode = 1;
  });
}
