// A Node ESM loader hook that transforms .jsx sources with esbuild so DOM
// behavior tests can import the real web-v2 React components directly,
// instead of re-implementing their logic against jsdom by hand.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.jsx')) return nextLoad(url, context);
  const source = await readFile(fileURLToPath(url), 'utf8');
  const { code } = await esbuild.transform(source, {
    loader: 'jsx',
    jsx: 'automatic',
    format: 'esm',
    sourcefile: fileURLToPath(url),
  });
  return { format: 'module', source: code, shortCircuit: true };
}
