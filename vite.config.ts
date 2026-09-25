import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('./plugin.json', import.meta.url), 'utf-8'))

export default defineConfig({
    plugins: [svelte({ compilerOptions: { css: 'injected' } })],
    build: {
        lib: {
            entry: resolve(__dirname, 'index.ts'),
            formats: ['es'],
            fileName: () => manifest.entry,
        },
        outDir: 'dist',
        emptyOutDir: true,
        target: 'es2022',
        minify: false,
    },
})
