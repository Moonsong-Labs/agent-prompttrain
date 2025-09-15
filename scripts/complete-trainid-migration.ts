#!/usr/bin/env bun

/**
 * Complete migration script to replace domain with train-id
 * This script performs comprehensive updates across the codebase
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

const replacements = [
  // RequestContext property changes
  { from: /context\.host/g, to: 'context.trainId' },
  { from: /\.host\b/g, to: '.trainId' },
  
  // Variable and parameter names
  { from: /\bdomain:/g, to: 'trainId:' },
  { from: /\bdomain,/g, to: 'trainId,' },
  { from: /\bdomain\s*=/g, to: 'trainId =' },
  { from: /const domain\b/g, to: 'const trainId' },
  { from: /let domain\b/g, to: 'let trainId' },
  
  // SQL column references
  { from: /r\.domain/g, to: 'r.train_id' },
  { from: /api_requests\.domain/g, to: 'api_requests.train_id' },
  
  // Function calls
  { from: /authenticatePersonalDomain/g, to: 'authenticate' },
  { from: /authenticateNonPersonalDomain/g, to: 'authenticate' },
  
  // Types and interfaces
  { from: /domain\?:/g, to: 'trainId?:' },
  { from: /'domain'/g, to: "'trainId'" },
  { from: /"domain"/g, to: '"trainId"' },
];

function processFile(filepath: string) {
  if (filepath.includes('node_modules') || 
      filepath.includes('.git') || 
      filepath.includes('dist') ||
      filepath.includes('.migration-backup') ||
      filepath.includes('complete-trainid-migration.ts')) {
    return;
  }

  const ext = extname(filepath);
  if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
    return;
  }

  try {
    let content = readFileSync(filepath, 'utf-8');
    let modified = false;

    for (const { from, to } of replacements) {
      const newContent = content.replace(from, to);
      if (newContent !== content) {
        modified = true;
        content = newContent;
      }
    }

    if (modified) {
      writeFileSync(filepath, content);
      console.log(`Updated: ${filepath}`);
    }
  } catch (error) {
    console.error(`Error processing ${filepath}:`, error);
  }
}

function processDirectory(dir: string) {
  const entries = readdirSync(dir);
  
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    
    if (stat.isDirectory()) {
      processDirectory(fullPath);
    } else if (stat.isFile()) {
      processFile(fullPath);
    }
  }
}

// Process the codebase
console.log('Starting comprehensive train-id migration...');
processDirectory('./services/proxy/src');
processDirectory('./services/dashboard/src');
processDirectory('./packages/shared/src');
console.log('Migration complete!');