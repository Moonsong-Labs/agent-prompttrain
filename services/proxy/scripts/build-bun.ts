#!/usr/bin/env bun

import { $ } from 'bun'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

console.log('Building Agent Prompt Train Service with Bun...')

const distDir = join(__dirname, '..', 'dist')
const srcDir = join(__dirname, '..', 'src')

try {
  // Clean dist directory
  if (existsSync(distDir)) {
    rmSync(distDir, { recursive: true, force: true })
  }
  mkdirSync(distDir, { recursive: true })

  // Build with Bun
  await $`bun build ${join(srcDir, 'main.ts')} --outdir ${distDir} --target node --minify`

  // Copy package.json to dist for runtime
  await $`cp ${join(__dirname, '..', 'package.json')} ${distDir}/`

  // Make the main file executable
  await $`chmod +x ${join(distDir, 'main.js')}`

  console.log('✅ Build completed successfully!')
  console.log(`📦 Output: ${distDir}`)
} catch (error) {
  console.error('❌ Build failed:', error)
  process.exit(1)
}
