#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  classifyReadability,
  decodePng,
  judgeSamples,
  textSamplerSource,
} from './readability.mjs';

const execFileAsync = promisify(execFile);

export function parseCliArgs(argv) {
  const values = [...argv];
  const command = values.shift();
  const options = {
    force: false,
    launch: false,
    relaunch: false,
    worker: false,
    silent: false,
    port: Number(process.env.CODEXSKIN_CDP_PORT || '9341'),
    app: undefined,
  };
  const positional = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--force') options.force = true;
    else if (value === '--launch') options.launch = true;
    else if (value === '--relaunch') options.relaunch = true;
    else if (value === '--launch-worker') options.worker = true;
    else if (value === '--port') {
      const port = Number(values[++index]);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        fail('--port must be an integer between 1024 and 65535.');
      }
      options.port = port;
    } else if (value === '--app') {
      const app = values[++index];
      if (!app) fail('--app requires an application path.');
      options.app = resolve(app);
    } else if (value?.startsWith('--')) {
      fail(`Unknown option: ${value}`);
    } else positional.push(value);
  }
  return { command, argument: positional[0], positional, options };
}

const parsedCli = parseCliArgs(process.argv.slice(2));
const { command, argument, options: cliOptions } = parsedCli;
const baseUrl = (
  process.env.CODEXSKIN_API_BASE ||
  process.env.CODEXSKIN_BASE_URL ||
  'https://codexskin.cool'
).replace(/\/$/, '');
const root = resolve(process.env.CODEXSKIN_HOME || join(homedir(), '.codexskin'));
const themesDir = join(root, 'themes');
const exportsDir = join(root, 'exports');
const stateDir = join(root, 'state');
const previewCacheDir = join(root, 'cache', 'previews');

const unsafeCss = [
  /@import/i,
  /url\s*\(\s*['"]?https?:/i,
  /url\s*\(\s*['"]?(?:\/\/|file:|blob:)/i,
  /javascript\s*:/i,
  /<script/i,
  /expression\s*\(/i,
];

export function fail(message) {
  throw new Error(message);
}

function validateThemeId(id) {
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(String(id || ''))) {
    fail('Theme id is unsafe.');
  }
  return String(id);
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
  validateThemeId(value.manifest.id);
  if (value.css.length > 1024 * 1024 || unsafeCss.some((rule) => rule.test(value.css))) {
    fail('Theme CSS contains an unsafe or external resource.');
  }
  if (/codexthemes/i.test(value.css)) {
    fail('Theme CSS contains a foreign runtime marker; use CodexSkin-owned markers.');
  }
  if (!value.css.includes(`data-codexskin-theme="${value.manifest.id}"`)) {
    fail('Theme CSS is not scoped to the manifest data-codexskin-theme marker.');
  }
  for (const [label, localized] of [
    ['manifest.displayNameZh', value.manifest.displayNameZh],
    ['manifest.descriptionZh', value.manifest.descriptionZh],
    ['readmeZh', value.readmeZh],
  ]) {
    if (localized !== undefined && typeof localized !== 'string') {
      fail(`${label} must be a string when provided.`);
    }
  }
  const stylesheet = validateRelativeFilename(value.manifest.css || 'theme.css', 'Manifest stylesheet');
  if (extname(stylesheet).toLowerCase() !== '.css') fail('Manifest stylesheet must use a .css filename.');
  if (value.manifest.art) validateRelativeFilename(value.manifest.art, 'Manifest artwork');
  const embeddedAssets = [value.art, value.preview, ...(value.images || [])].filter(Boolean);
  for (const asset of embeddedAssets) {
    if (!asset.data || !asset.mimeType) fail('Embedded image asset is incomplete.');
    validateRelativeFilename(asset.filename || 'image', 'Embedded asset');
    const bytes = Buffer.from(asset.data, 'base64');
    if (bytes.length > 15 * 1024 * 1024) fail('Embedded image asset exceeds 15 MB.');
    validateImageBytes(bytes, asset.mimeType);
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 30 * 1024 * 1024) {
    fail('Portable theme package exceeds 30 MB.');
  }
  // Check raw fields, NOT the JSON-serialized package: serialization escapes
  // newlines as `\n`, which would turn innocent CSS like `background:\n…`
  // into a fake Windows drive prefix (`d:\`) and cause false positives.
  const rawHaystack = [
    value.css,
    value.readme || '',
    value.readmeZh || '',
    JSON.stringify(value.manifest),
  ].join('\n');
  if (
    /(?<![A-Za-z])[A-Za-z]:[\\/]|\/(?:Users|home|private|tmp)\//.test(
      rawHaystack
    )
  ) {
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

function validateRelativeFilename(filename, label = 'Package file') {
  const normalized = String(filename).replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    isAbsolute(normalized) ||
    /^[A-Za-z]:/.test(normalized) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    fail(`${label} path is unsafe: ${filename}`);
  }
  return normalized;
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after');
    const retry = retryAfter ? ` Retry after ${retryAfter} seconds.` : '';
    fail(`${body.code ? `${body.code}: ` : ''}${body.error || `${response.status} ${response.statusText}`}.${retry}`.trim());
  }
  return body;
}

function authHeaders() {
  return process.env.CODEXSKIN_API_KEY
    ? { Authorization: `Bearer ${process.env.CODEXSKIN_API_KEY}` }
    : {};
}

async function cachePreview(item) {
  if (!item.previewUrl) return null;
  const previewUrl = item.previewUrl.startsWith('http')
    ? item.previewUrl
    : `${baseUrl}${item.previewUrl}`;
  const response = await fetch(previewUrl, { headers: authHeaders() }).catch(() => null);
  if (!response) return null;
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 15 * 1024 * 1024) return null;
  const contentType = response.headers.get('content-type')?.split(';')[0] || '';
  let extension;
  try {
    extension = extensionFor(contentType);
    validateImageBytes(bytes, contentType);
  } catch {
    return null;
  }
  await mkdir(previewCacheDir, { recursive: true });
  const filename = join(previewCacheDir, `${String(item.slug).replace(/[^a-zA-Z0-9._-]/g, '-')}.${extension}`);
  await writeFile(filename, bytes);
  return filename;
}

export async function findThemes(query = '') {
  const params = new URLSearchParams({ q: query, limit: '5' });
  const body = await fetchJson(`/api/themes?${params}`, {
    headers: authHeaders(),
  });
  const results = [];
  for (const item of (body.themes || []).slice(0, 5)) {
    const type = item.kind === 'theme' ? 'THEME' : 'SKIN';
    const state = item.installable ? 'installable' : 'visual reference';
    const url = item.url?.startsWith('http')
      ? item.url
      : `${baseUrl}${item.url || `/${item.kind === 'skin' ? 'skins' : 'themes'}/${item.slug}`}`;
    const preview = await cachePreview(item);
    console.log(
      [
        type,
        item.slug,
        item.name,
        item.authorName || item.creator || 'Unknown',
        state,
        item.description || '',
        url,
        preview || 'preview unavailable',
      ].join('\t')
    );
    results.push({ ...item, detailUrl: url, localPreview: preview });
  }
  return results;
}

async function writeEmbeddedAsset(output, fallbackName, asset) {
  if (!asset?.data || !asset?.mimeType) return null;
  const bytes = Buffer.from(asset.data, 'base64');
  validateImageBytes(bytes, asset.mimeType);
  const rawName = String(asset.filename || fallbackName).replaceAll('\\', '/');
  const expectedExtension = extensionFor(asset.mimeType);
  const filename = extname(rawName) ? rawName : `${rawName}.${expectedExtension}`;
  const destination = safeOutputPath(output, filename, 'Embedded asset');
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  return filename;
}

function safeOutputPath(output, filename, label = 'Package file') {
  const normalized = validateRelativeFilename(filename, label);
  const destination = resolve(output, normalized);
  const relation = relative(output, destination);
  if (relation.startsWith('..') || isAbsolute(relation)) {
    fail(`${label} path escapes the theme directory: ${filename}`);
  }
  return destination;
}

function requestedThemeId(input) {
  if (!input) fail('Usage: install <theme-id-or-slug> [--force]');
  try {
    const url = new URL(input);
    const match = url.pathname.match(/^\/themes\/([^/]+)\/?$/);
    if (url.hostname === 'codexskin.cool' && match) return validateThemeId(decodeURIComponent(match[1]));
  } catch {
    // A plain theme id is expected in the common case.
  }
  return validateThemeId(input);
}

async function directoryHasFiles(directory) {
  return (await readdir(directory).catch(() => [])).length > 0;
}

export async function installTheme(input, { force = false } = {}) {
  const id = requestedThemeId(input);
  const detail = await fetchJson(`/api/themes/${encodeURIComponent(id)}`, {
    headers: authHeaders(),
  });
  const entry = detail.theme || detail.entry || detail;
  if (entry.kind !== 'theme' || !entry.installable) {
    const detailUrl = entry.url?.startsWith('http')
      ? entry.url
      : `${baseUrl}${entry.url || `/skins/${id}`}`;
    fail(`NOT_INSTALLABLE: This entry is a visual Skin reference. ${detailUrl}`);
  }
  const response = await fetch(
    `${baseUrl}/api/themes/${encodeURIComponent(id)}/download`,
    { headers: authHeaders(), redirect: 'follow' }
  );
  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after');
    fail(`Theme download failed: ${response.status}${retryAfter ? `; retry after ${retryAfter} seconds` : ''}.`);
  }
  const text = await response.text();
  const packageData = validatePackage(JSON.parse(text));
  if (packageData.manifest.id !== id) {
    fail(`Downloaded manifest id "${packageData.manifest.id}" does not match requested theme "${id}".`);
  }
  const idSafe = packageData.manifest.id.replace(/[^a-zA-Z0-9._-]/g, '-');
  const output = join(themesDir, idSafe);
  if (!force && await directoryHasFiles(output)) {
    fail(`Theme ${id} is already installed. Re-run with --force only to replace the existing copy.`);
  }
  await mkdir(themesDir, { recursive: true });
  const staging = await mkdtemp(join(themesDir, `.install-${idSafe}-`));
  let backup;
  try {
    await writeFile(join(staging, 'package.codexskin-theme'), text, 'utf8');
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(packageData.manifest, null, 2)}\n`);
    const cssPath = safeOutputPath(staging, packageData.manifest.css || 'theme.css', 'Stylesheet');
    await mkdir(dirname(cssPath), { recursive: true });
    await writeFile(cssPath, packageData.css, 'utf8');
    await writeFile(join(staging, 'README.md'), packageData.readme || '', 'utf8');
    await writeEmbeddedAsset(staging, 'art', packageData.art);
    await writeEmbeddedAsset(staging, 'preview', packageData.preview);
    for (const asset of packageData.images || []) await writeEmbeddedAsset(staging, 'image', asset);
    if (await directoryHasFiles(output)) {
      backup = `${output}.backup-${Date.now()}`;
      await rename(output, backup);
    }
    await rename(staging, output);
    if (backup) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (backup) await rename(backup, output).catch(() => undefined);
    throw error;
  }
  const installed = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  if (installed.id !== id) fail(`Installed manifest id "${installed.id}" does not match requested theme "${id}".`);
  console.log(`Installed ${installed.id} version ${installed.version} at ${output}/.`);
  return { id: installed.id, version: installed.version, output };
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
  // Portable packages must be self-contained. Inlining here keeps published
  // themes compatible with switchers that validate CSS before extracting the
  // package's local image assets.
  const portableCss = await inlineLocalAssets(css, input);
  const readme = await readFile(join(input, 'README.md'), 'utf8').catch(() => '');
  const readmeZh = await readFile(join(input, 'README.zh.md'), 'utf8').catch(() => '');
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
    css: portableCss,
    readme,
    ...(readmeZh ? { readmeZh } : {}),
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
      sha256: createHash('sha256').update(portableCss).digest('hex'),
    },
  });
  await mkdir(exportsDir, { recursive: true });
  const output = join(exportsDir, `${manifest.id}.codexskin-theme`);
  await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  console.log(`Created ${output}`);
  return output;
}

export class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!Number.isInteger(message.id)) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else request.resolve(message.result || {});
    });
    const rejectPending = () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Codex debugging WebSocket closed unexpectedly.'));
      }
      this.pending.clear();
    };
    socket.addEventListener('error', rejectPending);
    socket.addEventListener('close', rejectPending);
  }

  static async connect(url, timeoutMs = 3000) {
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('Codex debugging connection timed out.'));
      }, timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolveOpen();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Cannot connect to the Codex renderer.'));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  call(method, params = {}, timeoutMs = 10_000) {
    const id = this.nextId;
    this.nextId = this.nextId >= 0x7ffffffe ? 1 : this.nextId + 1;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex debugging request timed out: ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function rawTargetsAt(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(1000),
  }).catch(() => null);
  if (!response?.ok) return [];
  const targets = await response.json().catch(() => []);
  if (!Array.isArray(targets)) return [];
  return targets.filter(
    (item) =>
      item.type === 'page' &&
      item.webSocketDebuggerUrl &&
      (!item.url || item.url.startsWith('app://'))
  );
}

export function isThemeableAppTarget(target) {
  try {
    const url = new URL(target.url);
    if (url.pathname.endsWith('/avatar-overlay-composition-surface.html')) {
      return false;
    }
    const route = url.searchParams.get('initialRoute');
    return !['/hotkey-window', '/avatar-overlay'].includes(route);
  } catch {
    return true;
  }
}

export async function sendCdp(target, method, params = {}, timeoutMs = 10_000) {
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    return await client.call(method, params, timeoutMs);
  } finally {
    client.close();
  }
}

export async function evaluateTarget(target, expression, timeoutMs = 10_000) {
  const result = await sendCdp(target, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, timeoutMs);
  if (result.exceptionDetails) {
    fail(`Codex rejected Runtime.evaluate for ${target.url || target.id}.`);
  }
  return result?.result?.value;
}

async function responsiveTargetsAt(port) {
  const appTargets = await rawTargetsAt(port);
  const candidates = appTargets.filter(isThemeableAppTarget);
  const auxiliary = appTargets
    .filter((target) => !isThemeableAppTarget(target))
    .map((target) => ({ ...target, reason: 'auxiliary-window' }));
  const checked = await Promise.all(candidates.map(async (target) => {
    try {
      const ready = await evaluateTarget(target, 'document.readyState', 2500);
      return ready ? { target } : { skipped: target };
    } catch {
      return { skipped: target };
    }
  }));
  return {
    targets: checked.flatMap((item) => item.target ? [item.target] : []),
    skipped: [
      ...auxiliary,
      ...checked.flatMap((item) => item.skipped ? [{ ...item.skipped, reason: 'unresponsive' }] : []),
    ],
  };
}

export async function locateCdpTargets(preferred = Number(process.env.CODEXSKIN_CDP_PORT || '9341')) {
  for (const port of [...new Set([preferred, 9335, 9222, 9223])]) {
    const located = await responsiveTargetsAt(port);
    if (located.targets.length > 0) return { port, ...located };
  }
  return null;
}

export async function cdpTargets(preferred) {
  const located = await locateCdpTargets(preferred);
  if (located) return located;
  const port = preferred || Number(process.env.CODEXSKIN_CDP_PORT || '9341');
  fail(`Codex debugging endpoint is not available on 127.0.0.1:${port}. Use --launch only after restart permission.`);
}

export async function detectApp(explicit) {
  if (explicit) {
    await access(explicit);
    return explicit;
  }
  if (process.platform === 'darwin') {
    const candidates = ['/Applications/Codex.app', '/Applications/ChatGPT.app'];
    const installed = [];
    for (const app of candidates) {
      if (await access(app).then(() => true).catch(() => false)) installed.push(app);
    }
    for (const app of installed) {
      if ((await macMainPids(app)).length > 0) return app;
    }
    if (installed[0]) return installed[0];
  }
  if (process.platform === 'win32') {
    for (const name of ['Codex', 'ChatGPT']) {
      const { stdout = '' } = await execFileAsync('powershell', [
        '-NoProfile',
        '-Command',
        `(Get-Process -Name ${name} -ErrorAction SilentlyContinue | Where-Object Path | Select-Object -First 1).Path`,
      ]).catch(() => ({ stdout: '' }));
      if (stdout.trim()) return stdout.trim();
    }
    const local = process.env.LOCALAPPDATA;
    const candidates = local ? [
      join(local, 'Programs', 'Codex', 'Codex.exe'),
      join(local, 'Programs', 'ChatGPT', 'ChatGPT.exe'),
      join(local, 'Microsoft', 'WindowsApps', 'Codex.exe'),
      join(local, 'Microsoft', 'WindowsApps', 'ChatGPT.exe'),
    ] : [];
    for (const app of candidates) {
      if (await access(app).then(() => true).catch(() => false)) return app;
    }
  }
  fail('Cannot find Codex.app or ChatGPT.app; pass --app with the full application path.');
}

async function macMainPids(app) {
  const executable = basename(app, '.app');
  const mainPath = join(app, 'Contents', 'MacOS', executable);
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command=']);
  return stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match && (match[2] === mainPath || match[2].startsWith(`${mainPath} `))
      ? [Number(match[1])]
      : [];
  });
}

async function waitUntil(condition, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  return false;
}

async function stopApp(app) {
  if (process.platform === 'darwin') {
    const name = basename(app, '.app');
    await execFileAsync('osascript', ['-e', `tell application ${JSON.stringify(name)} to quit`]).catch(() => undefined);
    if (await waitUntil(async () => (await macMainPids(app)).length === 0, 15_000)) return;
    for (const pid of await macMainPids(app)) process.kill(pid, 'SIGTERM');
    if (!await waitUntil(async () => (await macMainPids(app)).length === 0, 15_000)) {
      fail(`Could not stop ${name} cleanly.`);
    }
    return;
  }
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/IM', basename(app)]).catch(() => undefined);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
    return;
  }
  fail('Automatic launch supports macOS and Windows only.');
}

async function appIsRunning(app) {
  if (process.platform === 'darwin') return (await macMainPids(app)).length > 0;
  if (process.platform === 'win32') {
    const { stdout = '' } = await execFileAsync('tasklist', ['/FI', `IMAGENAME eq ${basename(app)}`, '/NH'])
      .catch(() => ({ stdout: '' }));
    return stdout.toLowerCase().includes(basename(app).toLowerCase());
  }
  return false;
}

async function launchAppWithDebugging(port, explicitApp, relaunch) {
  const app = await detectApp(explicitApp);
  if (relaunch || await appIsRunning(app)) await stopApp(app);
  const flags = ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`];
  if (process.platform === 'darwin') {
    await execFileAsync('open', ['-na', app, '--args', ...flags]);
  } else if (process.platform === 'win32') {
    const child = spawn(app, flags, { detached: true, stdio: 'ignore' });
    child.unref();
  }
  return app;
}

async function mainProcessCommandLine(app) {
  try {
    if (process.platform === 'darwin') {
      const pids = await macMainPids(app);
      if (!pids[0]) return '';
      const { stdout = '' } = await execFileAsync('ps', ['-p', String(pids[0]), '-o', 'command=']);
      return stdout.trim();
    }
    if (process.platform === 'win32') {
      const image = basename(app).replaceAll("'", "''");
      const { stdout = '' } = await execFileAsync('powershell', [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter \"Name='${image}'\" | Select-Object -First 1).CommandLine`,
      ]);
      return stdout.trim();
    }
  } catch {
    // The primary endpoint error remains actionable without diagnostics.
  }
  return '';
}

async function launchDiagnostics(app, port) {
  if (!await appIsRunning(app)) {
    return `Diagnosis: ${app} is not running after relaunch. Verify the application path and open it manually once.`;
  }
  const commandLine = await mainProcessCommandLine(app);
  if (commandLine.includes(`--remote-debugging-port=${port}`)) {
    return `Diagnosis: the host is running with loopback debugging flags but did not open 127.0.0.1:${port}; this app build may ignore or strip remote debugging.`;
  }
  return 'Diagnosis: the running host does not contain the requested debugging flags; a previous instance probably retained the Chromium profile lock. Retry with --launch --relaunch after restart permission.';
}

async function waitForCdpTargets(port, app, timeoutMs = 45_000) {
  let located;
  const ready = await waitUntil(async () => {
    const result = await responsiveTargetsAt(port);
    if (result.targets.length === 0) return false;
    located = { port, ...result };
    return true;
  }, timeoutMs, 500);
  if (!ready) {
    fail(`Codex relaunched but no responsive renderer appeared on 127.0.0.1:${port}.\n${await launchDiagnostics(app, port)}`);
  }
  return located;
}

function launchLogPath() {
  return join(stateDir, 'launch.log');
}

async function scheduleDetachedLaunch(id, options) {
  await mkdir(stateDir, { recursive: true });
  const logPath = launchLogPath();
  const logFd = openSync(logPath, 'w');
  const args = [
    process.argv[1],
    'switch',
    id,
    '--launch',
    '--launch-worker',
    '--port',
    String(options.port),
    ...(options.relaunch ? ['--relaunch'] : []),
    ...(options.force ? ['--force'] : []),
    ...(options.app ? ['--app', options.app] : []),
  ];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
  const result = {
    status: 'scheduled',
    themeId: id,
    logPath,
    note: 'Codex is restarting through a detached loopback-only helper. Run status after relaunch.',
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

export async function inlineLocalAssets(css, themeDir) {
  const matches = [...css.matchAll(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi)];
  let output = css;
  for (const match of matches) {
    const source = match[2].trim();
    if (/^(data:|#)/i.test(source)) {
      continue;
    }
    if (/^(https?:|\/\/|file:|blob:|javascript:)/i.test(source)) {
      fail(`External CSS asset is not allowed: ${source}`);
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
    let frame = 0;
    const update = () => {
      const root = document.documentElement;
      root.dataset.codexskinTheme = ${JSON.stringify(id)};
      root.dataset.codexskinBackgroundScope = ${JSON.stringify(backgroundScope)};
      document.querySelectorAll('[data-codexskin-surface]').forEach((node) => delete node.dataset.codexskinSurface);
      document.querySelectorAll('main.main-surface').forEach((main) => {
        const conversation = main.querySelector('[data-thread-find-target="conversation"], [data-thread-user-message-navigation-item-id]');
        const home = main.querySelector('section[class~="group/home-suggestions"], [data-composer-navigation-target="workspace-project"], [data-testid="prompt-suggestion"]');
        main.dataset.codexskinPage = conversation ? 'conversation' : home ? 'home' : 'system';
      });
      const surfaces = [
        ['terminal', '.xterm'],
        ['diff', '.monaco-diff-editor, [data-testid*="diff" i]'],
        ['output', '[data-testid*="output" i]'],
        ['code', 'pre'],
      ];
      for (const [kind, selector] of surfaces) {
        document.querySelectorAll(selector).forEach((node) => { node.dataset.codexskinSurface = kind; });
      }
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; update(); });
    };
    update();
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.__codexskinRuntime = {
      id: ${JSON.stringify(id)},
      dispose() {
        observer.disconnect();
        if (frame) cancelAnimationFrame(frame);
        document.getElementById('codexskin-runtime-theme')?.remove();
        delete document.documentElement.dataset.codexskinTheme;
        delete document.documentElement.dataset.codexskinBackgroundScope;
        document.querySelectorAll('[data-codexskin-page]').forEach((node) => delete node.dataset.codexskinPage);
        document.querySelectorAll('[data-codexskin-surface]').forEach((node) => delete node.dataset.codexskinSurface);
        delete window.__codexskinRuntime;
      }
    };
    return style.textContent.length > 0 && document.documentElement.dataset.codexskinTheme === ${JSON.stringify(id)};
  })()`;
}

async function readState() {
  return JSON.parse(await readFile(join(stateDir, 'current.json'), 'utf8').catch(() => '{}'));
}

async function writeState(value) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'current.json'), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
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

async function readInstalledTheme(id) {
  if (!id) fail('Usage: switch <installed-theme-id>');
  validateThemeId(id);
  const themeDir = join(themesDir, id);
  const manifest = JSON.parse(await readFile(join(themeDir, 'manifest.json'), 'utf8'));
  if (manifest.id !== id) {
    fail(`Installed manifest id "${manifest.id}" does not match requested theme "${id}".`);
  }
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
  return { themeDir, manifest, css };
}

async function injectTarget(target, previousRegistrations, source) {
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    for (const registration of previousRegistrations) {
      if (registration.targetId === target.id && registration.identifier) {
        await client.call('Page.removeScriptToEvaluateOnNewDocument', {
          identifier: registration.identifier,
        }).catch(() => undefined);
      }
    }
    await client.call('Page.enable');
    const registration = await client.call('Page.addScriptToEvaluateOnNewDocument', { source });
    const result = await client.call('Runtime.evaluate', {
      expression: source,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails || result.result?.value !== true) {
      fail(`Theme injection could not be verified for ${target.url || target.id}.`);
    }
    return { targetId: target.id, identifier: registration.identifier };
  } finally {
    client.close();
  }
}

const restoreSource = `(() => {
  window.__codexskinRuntime?.dispose?.();
  document.getElementById('codexskin-runtime-theme')?.remove();
  delete document.documentElement.dataset.codexskinTheme;
  delete document.documentElement.dataset.codexskinBackgroundScope;
  document.querySelectorAll('[data-codexskin-page]').forEach((node) => delete node.dataset.codexskinPage);
  document.querySelectorAll('[data-codexskin-surface]').forEach((node) => delete node.dataset.codexskinSurface);
  return !document.getElementById('codexskin-runtime-theme') && !document.documentElement.dataset.codexskinTheme;
})()`;

async function removeRuntime(located, registrations = []) {
  for (const target of located.targets) {
    const client = await CdpClient.connect(target.webSocketDebuggerUrl);
    try {
      for (const registration of registrations) {
        if (registration.targetId === target.id && registration.identifier) {
          await client.call('Page.removeScriptToEvaluateOnNewDocument', {
            identifier: registration.identifier,
          }).catch(() => undefined);
        }
      }
      const result = await client.call('Runtime.evaluate', {
        expression: restoreSource,
        returnByValue: true,
        awaitPromise: true,
      });
      if (!result.result?.value) fail(`Native appearance could not be verified for ${target.url || target.id}.`);
    } finally {
      client.close();
    }
  }
}

async function reinstatePrevious(located, attemptedRegistrations, previous, options) {
  await removeRuntime(
    located,
    [...attemptedRegistrations, ...(previous.registrations || [])]
  );
  if (!previous.current) {
    await writeState({ current: null, previous: null, restoredAt: new Date().toISOString() });
    return 'native';
  }
  await writeState(previous);
  await switchTheme(previous.current, false, {
    ...options,
    launch: false,
    relaunch: false,
    worker: true,
    force: true,
    silent: true,
  });
  return previous.current;
}

async function auditTarget(target) {
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await client.call('Page.enable');
    const sampled = await client.call('Runtime.evaluate', {
      expression: textSamplerSource,
      returnByValue: true,
    });
    const parsed = JSON.parse(sampled.result?.value || '{}');
    const viewportWidth = parsed.viewportWidth || 1024;
    const viewportHeight = parsed.viewportHeight || 768;
    const screenshotScale = Math.min(1, 900 / viewportWidth);
    const screenshot = await client.call('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      fromSurface: true,
      clip: {
        x: 0,
        y: 0,
        width: viewportWidth,
        height: viewportHeight,
        scale: screenshotScale,
      },
    }, 15_000);
    const image = decodePng(Buffer.from(screenshot.data, 'base64'));
    const judged = judgeSamples(
      image,
      (parsed.samples || []).filter((sample) => sample.size >= 9),
      parsed.viewportWidth || image.width
    );
    const classification = classifyReadability(judged);
    return {
      targetId: target.id,
      url: target.url,
      themeId: await client.call('Runtime.evaluate', {
        expression: 'document.documentElement.dataset.codexskinTheme || null',
        returnByValue: true,
      }).then((result) => result.result?.value),
      samples: judged.length,
      screenshotScale,
      status: classification.status,
      critical: classification.critical.slice(0, 10),
      warnings: classification.warnings.slice(0, 10),
    };
  } catch (error) {
    return {
      targetId: target.id,
      url: target.url,
      status: 'unverified',
      error: error.message,
      samples: 0,
      critical: [],
      warnings: [],
    };
  } finally {
    client.close();
  }
}

async function auditLocated(located) {
  const results = [];
  for (const target of located.targets) results.push(await auditTarget(target));
  const failed = results.some((item) => item.status !== 'pass');
  return {
    status: failed ? 'fail' : 'pass',
    pages: results.length,
    skippedTargets: located.skipped?.map((target) => ({
      id: target.id,
      url: target.url,
      reason: target.reason,
    })) || [],
    criticalCount: results.reduce((total, item) => total + item.critical.length, 0),
    warningCount: results.reduce((total, item) => total + item.warnings.length, 0),
    results,
  };
}

export async function switchTheme(id, preservePrevious = true, options = cliOptions) {
  const { manifest, css } = await readInstalledTheme(id);
  const previous = await readState();
  let located = await locateCdpTargets(options.port);
  if (!located || options.relaunch) {
    if (!options.launch) {
      fail(located
        ? 'A clean relaunch requires --launch and explicit restart permission.'
        : `Codex must restart before activation. Re-run switch ${id} --launch after explicit permission.`);
    }
    if (!options.worker) return scheduleDetachedLaunch(id, options);
    const app = await launchAppWithDebugging(options.port, options.app, true);
    located = await waitForCdpTargets(options.port, app);
  }
  const source = runtimeSource(id, manifest.design?.backgroundScope || 'home', css);
  const registrations = [];
  try {
    for (const target of located.targets) {
      registrations.push(await injectTarget(target, previous.registrations || [], source));
    }
  } catch (error) {
    let recoveryError;
    try {
      await reinstatePrevious(located, registrations, previous, options);
    } catch (recovery) {
      recoveryError = recovery;
    }
    fail(`Theme injection failed: ${error.message}${recoveryError ? ` Recovery also failed: ${recoveryError.message}` : ' The previous appearance was restored.'}`);
  }
  await writeState({
    current: id,
    previous: preservePrevious
      ? previous.current && previous.current !== id
        ? previous.current
        : previous.previous || null
      : previous.previous || null,
    port: located.port,
    registrations,
    appliedAt: new Date().toISOString(),
  });
  const status = await statusTheme(false, located);
  if (status.status !== 'active' || status.themeId !== id) {
    let recoveryError;
    try {
      await reinstatePrevious(located, registrations, previous, options);
    } catch (recovery) {
      recoveryError = recovery;
    }
    fail(`Theme injection marker did not survive the status check.${recoveryError ? ` Recovery also failed: ${recoveryError.message}` : ' The previous appearance was restored.'}`);
  }
  let audit;
  for (const settleMs of [1200, 1600]) {
    await new Promise((resolveWait) => setTimeout(resolveWait, settleMs));
    audit = await auditLocated(located);
    if (audit.status === 'pass') break;
  }
  if (audit.status === 'fail' && !options.force) {
    const fallback = await reinstatePrevious(located, registrations, previous, options);
    const result = {
      status: 'reverted',
      appliedThemeId: id,
      revertedTo: fallback,
      reason: 'readability audit could not verify a safe rendered result',
      audit,
    };
    if (!options.silent) console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
    return result;
  }
  const result = {
    status: 'active',
    themeId: id,
    pagesThemed: status.pages,
    port: located.port,
    backgroundScope: manifest.design?.backgroundScope || 'home',
    backgroundScopeNote: (manifest.design?.backgroundScope || 'home') === 'home'
      ? 'Background artwork shows on the home page only; colors and materials apply everywhere.'
      : 'Background artwork shows on the home and conversation pages.',
    skippedTargets: status.skippedTargets,
    readability: audit.warningCount > 0 || audit.criticalCount > 0
      ? {
          status: 'pass-with-warnings',
          warnings: audit.warningCount,
          isolatedCriticalSamples: audit.criticalCount,
        }
      : { status: 'pass', warnings: 0, isolatedCriticalSamples: 0 },
  };
  if (!options.silent) console.log(JSON.stringify(result, null, 2));
  return result;
}

export async function statusTheme(log = true, existingLocated) {
  const recordedState = await readState();
  const located = existingLocated ?? await locateCdpTargets(recordedState.port || cliOptions.port);
  const results = [];
  for (const target of located?.targets || []) {
    results.push({
      targetId: target.id,
      url: target.url,
      ...await evaluateTarget(target, `(() => ({
      active: Boolean(document.getElementById('codexskin-runtime-theme')),
      themeId: document.documentElement.dataset.codexskinTheme || null,
      pageMarkers: document.querySelectorAll('[data-codexskin-page]').length,
      surfaceMarkers: document.querySelectorAll('[data-codexskin-surface]').length
    }))()`),
    });
  }
  const ids = [...new Set(results.filter((item) => item.active).map((item) => item.themeId))];
  const active = results.length > 0 && results.every((item) => item.active) && ids.length === 1;
  const partiallyActive = results.some((item) => item.active);
  const status = {
    status: active ? 'active' : partiallyActive ? 'partial' : 'inactive',
    themeId: ids.length === 1 ? ids[0] : ids.length > 1 ? ids : null,
    pages: results.length,
    debugEndpoint: located ? `127.0.0.1:${located.port}` : null,
    recordedState,
    launchLog: launchLogPath(),
    skippedTargets: located?.skipped?.map((target) => ({
      id: target.id,
      url: target.url,
      reason: target.reason,
    })) || [],
    results,
  };
  if (log) console.log(JSON.stringify(status, null, 2));
  return status;
}

export async function auditTheme() {
  const state = await readState();
  const located = await locateCdpTargets(state.port || cliOptions.port);
  if (!located) {
    const report = {
      status: 'fail',
      pages: 0,
      error: 'No responsive Codex renderer is available for screenshot auditing.',
      debugEndpoint: null,
      launchLog: launchLogPath(),
      results: [],
    };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return report;
  }
  const report = await auditLocated(located);
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'fail') process.exitCode = 1;
  return report;
}

export async function restoreTheme(existingLocated) {
  const state = await readState();
  const located = existingLocated ?? await locateCdpTargets(state.port || cliOptions.port);
  if (!located) {
    await writeState({ current: null, previous: null, restoredAt: new Date().toISOString() });
    const result = {
      status: 'inactive',
      pagesRestored: 0,
      note: 'Codex is not exposing a renderer; local runtime state was cleared.',
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  await removeRuntime(located, state.registrations || []);
  await writeState({ current: null, previous: null, restoredAt: new Date().toISOString() });
  const result = { status: 'inactive', pagesRestored: located.targets.length };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

export async function rollbackTheme() {
  const state = await readState();
  if (!state.current) {
    const result = { status: 'native', note: 'No CodexSkin theme is currently recorded.' };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (!state.previous || state.previous === state.current) return restoreTheme();
  return switchTheme(state.previous, true);
}

export function submissionPayload(value) {
  return {
    name: value.manifest.displayName,
    nameZh: value.manifest.displayNameZh,
    creator: value.manifest.author?.name || 'Community creator',
    description: value.readme || '',
    descriptionZh: value.readmeZh || value.manifest.descriptionZh || '',
    rightsConfirmed: true,
    package: value,
    previewBase64: value.preview
      ? `data:${value.preview.mimeType};base64,${value.preview.data}`
      : undefined,
  };
}

export async function submitTheme(packagePath) {
  if (!packagePath) fail('Usage: submit <package.codexskin-theme>');
  const value = validatePackage(JSON.parse(await readFile(resolve(packagePath), 'utf8')));
  if (!process.env.CODEXSKIN_API_KEY) {
    console.warn('No CODEXSKIN_API_KEY is configured. This will be an anonymous submission awaiting review.');
  }
  if (!value.manifest.displayNameZh || !(value.readmeZh || value.manifest.descriptionZh)) {
    console.warn('Chinese theme metadata is incomplete. Add manifest.displayNameZh and README.zh.md before publishing a bilingual listing.');
  }
  const body = await fetchJson('/api/themes/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(submissionPayload(value)),
  });
  console.log(`${body.status}: ${baseUrl}${body.url}`);
}

const commands = {
  find: () => findThemes(argument || ''),
  install: () => installTheme(argument, cliOptions),
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
    console.log('Usage: codexskin.mjs <find|install|validate|create|list|switch|status|audit|rollback|restore|submit> [argument] [--force] [--launch] [--relaunch] [--port 9341] [--app PATH]');
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
