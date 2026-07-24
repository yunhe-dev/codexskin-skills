import zlib from 'node:zlib';

export function parseColor(value) {
  const match = String(value).match(/rgba?\(([^)]+)\)/i);
  if (!match) return null;
  const parts = match[1]
    .replace('/', ' ')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return {
    r: parts[0],
    g: parts[1],
    b: parts[2],
    a: parts[3] ?? 1,
  };
}

function luminance({ r, g, b }) {
  const linear = (channel) => {
    const value = channel / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(first, second) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonalDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= diagonalDistance) return left;
  if (upDistance <= diagonalDistance) return up;
  return upperLeft;
}

export function decodePng(buffer) {
  const signature = '89504e470d0a1a0a';
  if (buffer.subarray(0, 8).toString('hex') !== signature) {
    throw new Error('Readability screenshot is not a PNG image.');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const compressed = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('Interlaced PNG screenshots are unsupported.');
    } else if (type === 'IDAT') {
      compressed.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += length + 12;
  }
  if (bitDepth !== 8 || ![2, 6].includes(colorType)) {
    throw new Error(`Unsupported PNG screenshot format (${bitDepth}/${colorType}).`);
  }
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const stride = width * bytesPerPixel;
  const raw = zlib.inflateSync(Buffer.concat(compressed));
  const pixels = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (stride + 1);
    const filter = raw[rowOffset];
    const current = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const encoded = raw[rowOffset + 1 + x];
      const left = x >= bytesPerPixel ? current[x - bytesPerPixel] : 0;
      const up = previous[x];
      const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      if (filter === 0) current[x] = encoded;
      else if (filter === 1) current[x] = (encoded + left) & 0xff;
      else if (filter === 2) current[x] = (encoded + up) & 0xff;
      else if (filter === 3) current[x] = (encoded + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) current[x] = (encoded + paeth(left, up, upperLeft)) & 0xff;
      else throw new Error(`Unsupported PNG row filter ${filter}.`);
    }
    for (let x = 0; x < width; x += 1) {
      const source = x * bytesPerPixel;
      const destination = (y * width + x) * 4;
      pixels[destination] = current[source];
      pixels[destination + 1] = current[source + 1];
      pixels[destination + 2] = current[source + 2];
      pixels[destination + 3] = bytesPerPixel === 4 ? current[source + 3] : 255;
    }
    previous = current;
  }
  return { width, height, pixels };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

export function ringBackdrop(image, rect, scale, padding = 3) {
  const left = Math.round((rect.x - padding) * scale);
  const right = Math.round((rect.x + rect.width + padding) * scale);
  const top = Math.round((rect.y - padding) * scale);
  const bottom = Math.round((rect.y + rect.height + padding) * scale);
  const horizontalStep = Math.max(1, Math.floor((right - left) / 24));
  const verticalStep = Math.max(1, Math.floor((bottom - top) / 12));
  const points = [];
  for (let x = left; x <= right; x += horizontalStep) points.push([x, top], [x, bottom]);
  for (let y = top; y <= bottom; y += verticalStep) points.push([left, y], [right, y]);
  const channels = [[], [], []];
  for (const [x, y] of points) {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
    const pixel = (y * image.width + x) * 4;
    channels[0].push(image.pixels[pixel]);
    channels[1].push(image.pixels[pixel + 1]);
    channels[2].push(image.pixels[pixel + 2]);
  }
  if (channels[0].length < 8) return null;
  return {
    r: median(channels[0]),
    g: median(channels[1]),
    b: median(channels[2]),
    a: 1,
  };
}

export function judgeSamples(image, samples, viewportWidth) {
  const scale = image.width / viewportWidth;
  const results = [];
  for (const sample of samples) {
    const foreground = parseColor(sample.color);
    const backdrop = ringBackdrop(image, sample.rect, scale);
    if (!foreground || !backdrop) continue;
    const rendered = foreground.a < 1
      ? {
          r: foreground.r * foreground.a + backdrop.r * (1 - foreground.a),
          g: foreground.g * foreground.a + backdrop.g * (1 - foreground.a),
          b: foreground.b * foreground.a + backdrop.b * (1 - foreground.a),
          a: 1,
        }
      : foreground;
    const ratio = Math.round(contrastRatio(rendered, backdrop) * 100) / 100;
    results.push({
      ...sample,
      ratio,
      backdrop: `rgb(${backdrop.r}, ${backdrop.g}, ${backdrop.b})`,
    });
  }
  return results.sort((a, b) => a.ratio - b.ratio);
}

export const textSamplerSource = `(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width >= 5 && rect.height >= 5 && rect.bottom >= 0 && rect.top <= innerHeight &&
      rect.right >= 0 && rect.left <= innerWidth && style.visibility !== 'hidden' &&
      style.display !== 'none' && Number(style.opacity) > 0.15;
  };
  const ownText = (element) => [...element.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent.trim())
    .filter(Boolean)
    .join(' ');
  const describe = (element) => {
    const path = [];
    let current = element;
    for (let depth = 0; current && depth < 3; depth += 1) {
      let part = current.tagName.toLowerCase();
      const classes = [...current.classList].slice(0, 2).join('.');
      if (classes) part += '.' + classes;
      path.unshift(part);
      current = current.parentElement;
    }
    return path.join(' > ');
  };
  const samples = [];
  for (const element of document.querySelectorAll('main *, aside *, header *, [role="menu"] *, [role="dialog"] *')) {
    if (samples.length >= 240) break;
    const text = ownText(element);
    if (text.length < 2 || !visible(element)) continue;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    samples.push({
      text: text.slice(0, 80),
      path: describe(element),
      color: style.color,
      size: parseFloat(style.fontSize) || 0,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
  }
  return JSON.stringify({
    samples,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    devicePixelRatio,
  });
})()`;

export function classifyReadability(results) {
  const critical = results.filter((item) => item.ratio < 2.5);
  const warnings = results.filter((item) => {
    const target = item.size >= 24 ? 3 : 4.5;
    return item.ratio >= 2.5 && item.ratio < target;
  });
  return {
    status: critical.length >= 2 ? 'fail' : 'pass',
    critical,
    warnings,
  };
}
