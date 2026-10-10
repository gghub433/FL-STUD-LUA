// Bundles the official Anthropic SDK (devDependency @anthropic-ai/sdk) into one ES module the page can import
// without a bundler: src/vendor/anthropic-sdk.js. Run after updating the SDK: node tools/vendor-sdk.mjs
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../node_modules/@anthropic-ai/sdk/package.json', import.meta.url)));
await build({
  stdin: { contents: "export { default, Anthropic } from '@anthropic-ai/sdk';", resolveDir: new URL('..', import.meta.url).pathname },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none',
  banner: { js: `// @anthropic-ai/sdk ${version} (MIT, https://github.com/anthropics/anthropic-sdk-typescript), bundled by tools/vendor-sdk.mjs` },
  outfile: new URL('../src/vendor/anthropic-sdk.js', import.meta.url).pathname,
});
console.log(`src/vendor/anthropic-sdk.js: @anthropic-ai/sdk ${version}`);
