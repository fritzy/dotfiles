import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';

import { PanelModelError } from './panels.js';

const TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg',
}));

const contained = (root, path) => {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

export function readHtmlResourceFile(resource, requested) {
  if (resource.kind !== 'html') throw new PanelModelError(400, 'resource must be HTML');
  if (!requested || requested.includes('\0') || requested.includes('\\') || isAbsolute(requested)) {
    throw new PanelModelError(400, 'invalid HTML asset path');
  }
  try {
    const root = realpathSync(dirname(resource.value));
    const candidate = resolve(root, requested);
    if (!contained(root, candidate)) throw new PanelModelError(403, 'asset must stay within the HTML directory');
    const path = realpathSync(candidate);
    if (!contained(root, path)) throw new PanelModelError(403, 'asset must stay within the HTML directory');
    if (!statSync(path).isFile()) throw new PanelModelError(404, 'no such HTML asset');
    const contentType = TYPES.get(extname(path).toLowerCase());
    if (!contentType) throw new PanelModelError(415, 'unsupported HTML asset type');
    return { body: readFileSync(path), contentType };
  } catch (error) {
    if (error instanceof PanelModelError) throw error;
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new PanelModelError(404, 'no such HTML asset');
    if (error.code === 'EACCES') throw new PanelModelError(403, 'HTML asset is not readable');
    throw error;
  }
}

export function serveHtmlResourceFile(res, resource, requested, headOnly = false) {
  const { body, contentType } = readHtmlResourceFile(resource, requested);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // Give local documents an opaque origin, including when opened externally.
    // They can render scripts but cannot read or mutate the daemon's API.
    'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; font-src 'self' data: https:; media-src 'self' blob: https:; connect-src 'none'; form-action 'none'; base-uri 'none'",
    'Access-Control-Allow-Origin': '*',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(headOnly ? undefined : body);
}
