import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/unified-server.ts', 'src/hook-merger.ts'],
  format: ['esm'],
  target: 'esnext',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: {
    compilerOptions: {
      allowImportingTsExtensions: true
    }
  },
  external: ['@modelcontextprotocol/sdk']
});