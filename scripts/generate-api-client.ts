#!/usr/bin/env bun
/**
 * Generate TypeScript client from OpenAPI specification
 *
 * This script uses openapi-typescript-codegen to generate a TypeScript client
 * from the AI Analysis API OpenAPI specification.
 *
 * Usage:
 *   bun run scripts/generate-api-client.ts
 */

import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'

const OPENAPI_SPEC = path.join(process.cwd(), 'docs/api/openapi-analysis.yaml')
const OUTPUT_DIR = path.join(process.cwd(), 'packages/shared/src/generated/api-client')

async function generateClient() {
  console.log('🚀 Generating TypeScript client from OpenAPI spec...')

  // Check if OpenAPI spec exists
  try {
    await fs.access(OPENAPI_SPEC)
  } catch (error) {
    console.error('❌ OpenAPI spec not found at:', OPENAPI_SPEC)
    process.exit(1)
  }

  // Ensure output directory exists
  await fs.mkdir(OUTPUT_DIR, { recursive: true })

  // Generate client using openapi-typescript-codegen
  const args = [
    'openapi-typescript-codegen',
    '--input',
    OPENAPI_SPEC,
    '--output',
    OUTPUT_DIR,
    '--client',
    'fetch',
    '--useOptions',
    '--useUnionTypes',
  ]

  return new Promise<void>((resolve, reject) => {
    const proc = spawn('bunx', args, {
      stdio: 'inherit',
      shell: true,
    })

    proc.on('close', code => {
      if (code === 0) {
        console.log('✅ Client generated successfully at:', OUTPUT_DIR)
        resolve()
      } else {
        reject(new Error(`Process exited with code ${code}`))
      }
    })

    proc.on('error', err => {
      reject(err)
    })
  })
}

// Alternative: Generate using OpenAPI TypeScript (more modern approach)
async function generateClientV2() {
  console.log('🚀 Generating TypeScript types from OpenAPI spec...')

  const args = ['openapi-typescript', OPENAPI_SPEC, '--output', path.join(OUTPUT_DIR, 'types.ts')]

  return new Promise<void>((resolve, reject) => {
    const proc = spawn('bunx', args, {
      stdio: 'inherit',
      shell: true,
    })

    proc.on('close', code => {
      if (code === 0) {
        console.log('✅ Types generated successfully')
        resolve()
      } else {
        reject(new Error(`Process exited with code ${code}`))
      }
    })

    proc.on('error', err => {
      reject(err)
    })
  })
}

// Simple fetch-based client generator (no external dependencies)
async function generateSimpleClient() {
  console.log('🚀 Generating simple TypeScript client...')

  const clientCode = `/**
 * Auto-generated API client for Agent Prompt Project AI Analysis API
 * Generated from: ${OPENAPI_SPEC}
 * Generated on: ${new Date().toISOString()}
 */

export interface CreateAnalysisRequest {
  conversationId: string
  branchId: string
}

export interface CreateAnalysisResponse {
  message: string
  analysisId: number
  status: 'pending' | 'processing' | 'completed' | 'failed'
}

export interface GetAnalysisResponse {
  id: number
  conversationId: string
  branchId: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  content?: string
  data?: ConversationAnalysis
  error?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
  tokenUsage: {
    prompt: number | null
    completion: number | null
    total: number
  }
}

export interface RegenerateAnalysisResponse {
  message: string
  analysisId: number
  status: 'pending' | 'processing' | 'completed' | 'failed'
}

export interface ConversationAnalysis {
  summary: string
  keyTopics: string[]
  sentiment: 'positive' | 'neutral' | 'negative' | 'mixed'
  userIntent: string
  outcomes: string[]
  actionItems: string[]
  technicalDetails: {
    frameworks: string[]
    issues: string[]
    solutions: string[]
  }
  conversationQuality: {
    clarity: 'high' | 'medium' | 'low'
    completeness: 'complete' | 'partial' | 'incomplete'
    effectiveness: 'highly effective' | 'effective' | 'needs improvement'
  }
}

export interface ApiClientOptions {
  baseUrl: string
  apiKey: string
  headers?: Record<string, string>
}

export class AnalysisApiClient {
  private baseUrl: string
  private headers: Record<string, string>

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\\/+$/, '')
    this.headers = {
      'Content-Type': 'application/json',
      'X-Dashboard-Key': options.apiKey,
      ...options.headers,
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const response = await fetch(\`\${this.baseUrl}\${path}\`, {
      method,
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }))
      throw new Error(\`API Error (\${response.status}): \${JSON.stringify(error)}\`)
    }

    return response.json()
  }

  /**
   * Create a new analysis request
   */
  async createAnalysis(request: CreateAnalysisRequest): Promise<CreateAnalysisResponse> {
    return this.request<CreateAnalysisResponse>('POST', '/api/analyses', request)
  }

  /**
   * Get analysis result
   */
  async getAnalysis(conversationId: string, branchId: string): Promise<GetAnalysisResponse> {
    return this.request<GetAnalysisResponse>(
      'GET',
      \`/api/analyses/\${conversationId}/\${branchId}\`
    )
  }

  /**
   * Regenerate analysis
   */
  async regenerateAnalysis(
    conversationId: string,
    branchId: string
  ): Promise<RegenerateAnalysisResponse> {
    return this.request<RegenerateAnalysisResponse>(
      'POST',
      \`/api/analyses/\${conversationId}/\${branchId}/regenerate\`
    )
  }

  /**
   * Poll for analysis completion
   * @param conversationId - Conversation ID
   * @param branchId - Branch ID
   * @param options - Polling options
   * @returns Completed analysis
   */
  async waitForAnalysis(
    conversationId: string,
    branchId: string,
    options: {
      pollingInterval?: number
      timeout?: number
      onProgress?: (status: string) => void
    } = {}
  ): Promise<GetAnalysisResponse> {
    const { pollingInterval = 2000, timeout = 300000, onProgress } = options
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      const analysis = await this.getAnalysis(conversationId, branchId)
      
      if (onProgress) {
        onProgress(analysis.status)
      }

      if (analysis.status === 'completed' || analysis.status === 'failed') {
        return analysis
      }

      await new Promise(resolve => setTimeout(resolve, pollingInterval))
    }

    throw new Error('Analysis timeout exceeded')
  }
}

// Export a factory function for convenience
export function createAnalysisClient(options: ApiClientOptions): AnalysisApiClient {
  return new AnalysisApiClient(options)
}
`

  const clientPath = path.join(OUTPUT_DIR, 'index.ts')
  await fs.mkdir(OUTPUT_DIR, { recursive: true })
  await fs.writeFile(clientPath, clientCode)

  console.log('✅ Simple client generated at:', clientPath)
}

// Main execution
async function main() {
  try {
    // Use the simple client generator by default
    await generateSimpleClient()

    console.log('\n📝 Example usage:')
    console.log(`
import { createAnalysisClient } from '@agent-prompttrain/shared/generated/api-client'

const client = createAnalysisClient({
  baseUrl: 'http://localhost:3000',
  apiKey: process.env.DASHBOARD_API_KEY!,
})

// Create analysis
const { analysisId } = await client.createAnalysis({
  conversationId: '123e4567-e89b-12d3-a456-426614174000',
  branchId: 'main',
})

// Wait for completion
const result = await client.waitForAnalysis(
  '123e4567-e89b-12d3-a456-426614174000',
  'main',
  {
    pollingInterval: 3000,
    onProgress: (status) => console.log('Status:', status),
  }
)

console.log('Analysis:', result.data)
`)
  } catch (error) {
    console.error('❌ Error generating client:', error)
    process.exit(1)
  }
}

// Run the script
main()
