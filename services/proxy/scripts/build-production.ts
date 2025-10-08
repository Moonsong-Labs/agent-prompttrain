#!/usr/bin/env bun

import { $ } from 'bun'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

console.log('🏗️  Building Agent Prompt Project Service for Production...')

const distDir = join(__dirname, '..', 'dist')
const srcDir = join(__dirname, '..', 'src')

try {
  // Clean dist directory
  if (existsSync(distDir)) {
    rmSync(distDir, { recursive: true, force: true })
  }
  mkdirSync(distDir, { recursive: true })

  console.log('📦 Bundling with optimizations...')

  // Build with Bun - production optimizations
  await $`bun build ${join(srcDir, 'main.ts')} \
    --outdir ${distDir} \
    --target node \
    --minify \
    --sourcemap \
    --external pg \
    --external @slack/webhook`

  // Create a minimal package.json for production
  const pkgJson = {
    name: '@agent-prompttrain/proxy',
    version: '2.0.0',
    type: 'module',
    main: 'main.js',
    dependencies: {
      // Only include runtime dependencies that weren't bundled
      pg: '^8.13.1',
      '@slack/webhook': '^7.0.3',
    },
  }

  writeFileSync(join(distDir, 'package.json'), JSON.stringify(pkgJson, null, 2))

  // Create entry point wrapper for better error handling
  const entryWrapper = `#!/usr/bin/env node
// Production entry point for Agent Prompt Project
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Set production environment
process.env.NODE_ENV = 'production';

// Import and run main
import('./main.js').catch(err => {
  console.error('Failed to start proxy service:', err);
  process.exit(1);
});
`

  writeFileSync(join(distDir, 'index.js'), entryWrapper)
  await $`chmod +x ${join(distDir, 'index.js')}`

  // Generate size report
  const sizeOutput = await $`du -sh ${distDir}`.text()
  const size = sizeOutput.split('\t')[0]
  const mainSizeOutput = await $`stat -c%s ${join(distDir, 'main.js')}`.text()
  const mainSizeMB = (parseInt(mainSizeOutput.trim()) / 1024 / 1024).toFixed(2)

  console.log('✅ Build completed successfully!')
  console.log(`📦 Output: ${distDir}`)
  console.log(`📊 Bundle size: ${mainSizeMB}MB (main.js)`)
  console.log(`📁 Total size: ${size}`)
} catch (error) {
  console.error('❌ Build failed:', error)
  process.exit(1)
}
