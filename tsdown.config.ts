/**
 * Client bundle build (tsdown / rolldown).
 *
 * A DSH client bundle is not an ES module. The shell's `client-modules` node
 * half serves `lib/client.js` and the browser half loads it as a classic
 * `<script>`, so the file must SELF-REGISTER by calling
 * `window.__ModuleLoader__.load({ id, factory })` — executing the script only
 * registers a factory, and the shell materializes it later through the `require`
 * it passes in. That is why this config wraps the emitted CommonJS body in the
 * exact envelope every shipped client bundle uses.
 *
 * Three consequences, all load-bearing:
 *
 * - **`format: 'cjs'`** gives the body a real `module.exports`/`require` pair,
 *   which is what the envelope's factory expects.
 * - **Only platform seed words stay external.** `react`, `react/jsx-runtime`,
 *   `react-dom`, `react-dom/client`, and `@deepseek-ai/cordis` are seeded by the
 *   shell itself, so they must be required at runtime rather than inlined (two
 *   React copies would break hooks). Everything else — the Markdown parser, the
 *   code highlighter, the API client — is inlined, which is why
 *   `dsh.client.external` stays empty: a specifier named there must be answered
 *   by another row, and a row that does not exist fails the browser boot.
 * - **TypeScript only type-checks this half.** `tsconfig.client.json` runs with
 *   `noEmit`; tsdown performs the transform.
 */

import { defineConfig } from 'tsdown'

/** Bundle identity: must equal the npm package name so `<id>/client` resolves. */
const PLUGIN_ID = '@company/dsh-starbridge-client'

export default defineConfig({
  entry: { client: 'src/client/index.tsx' },

  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,

  // Seeded by the shell's static module table, so they must NOT be inlined.
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis'],

  // Open the self-registration envelope: the classic script defines the loader
  // entry whose factory receives the module table's `require`.
  banner: `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(PLUGIN_ID)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,

  // Close it: hand the exports back through the factory's return value.
  footer: `\t\treturn module.exports;\n\t}\n});`,

  outputOptions: {
    entryFileNames: 'client.js',
    // The envelope, not the shell, owns the export surface.
    exports: 'named',
  },

  define: {
    'process.env.NODE_ENV': '"production"',
  },
})
