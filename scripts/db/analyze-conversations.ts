#!/usr/bin/env bun
/**
 * Script to analyze existing requests and show what conversation structure would be created
 * This is a dry-run version that doesn't modify the database
 */

import { Pool } from 'pg'
import { config } from 'dotenv'
import { createLoggingPool } from './utils/create-logging-pool.js'

// Load environment variables
config()

interface Request {
  request_id: string
  trainId: string
  timestamp: Date
  current_message_hash: string | null
  parent_message_hash: string | null
  conversation_id: string | null
  branch_id: string | null
  model: string
  total_tokens: number
}

interface ConversationAnalysis {
  trainId: string
  rootRequests: number
  totalRequests: number
  conversationChains: Array<{
    rootRequestId: string
    rootTimestamp: Date
    chainLength: number
    branches: number
    totalTokens: number
  }>
  orphanedRequests: number
  duplicateParentHashes: Map<string, number>
}

class ConversationAnalyzer {
  private pool: Pool
  private requestsByHash: Map<string, Request[]> = new Map()
  private requestsById: Map<string, Request> = new Map()

  constructor(databaseUrl: string) {
    this.pool = createLoggingPool(databaseUrl)
  }

  async analyze() {
    console.log('Starting conversation analysis...')

    try {
      // Load all requests
      console.log('\n1. Loading requests from database...')
      const requests = await this.loadRequests()
      console.log(`   Found ${requests.length} total requests`)

      // Build indices
      this.buildIndices(requests)

      // Analyze by trainId
      console.log('\n2. Analyzing conversations by train ID...')
      const trainIdAnalyses = this.analyzeByTrainId(requests)

      // Show results
      console.log('\n3. Analysis Results:')
      console.log('='.repeat(80))

      for (const [trainId, analysis] of Array.from(trainIdAnalyses.entries())) {
        console.log(`\nTrain ID: ${trainId}`)
        console.log('-'.repeat(40))
        console.log(`Total requests: ${analysis.totalRequests}`)
        console.log(`Root requests (no parent): ${analysis.rootRequests}`)
        console.log(`Orphaned requests (parent not found): ${analysis.orphanedRequests}`)
        console.log(`Conversation chains: ${analysis.conversationChains.length}`)

        // Show duplicate parent hashes
        const duplicates = Array.from(analysis.duplicateParentHashes.entries())
          .filter(([_, count]) => count > 1)
          .sort((a, b) => b[1] - a[1]) as Array<[string, number]>

        if (duplicates.length > 0) {
          console.log(`\nParent hashes with multiple children (branch points):`)
          for (const [hash, count] of duplicates.slice(0, 5)) {
            console.log(`  ${hash.substring(0, 8)}... → ${count} children`)
          }
          if (duplicates.length > 5) {
            console.log(`  ... and ${duplicates.length - 5} more`)
          }
        }

        // Show top conversation chains
        const topChains = analysis.conversationChains
          .sort((a, b) => b.chainLength - a.chainLength)
          .slice(0, 5)

        if (topChains.length > 0) {
          console.log(`\nTop conversation chains by length:`)
          for (const chain of topChains) {
            console.log(
              `  ${chain.rootRequestId.substring(0, 8)}... → ${chain.chainLength} messages, ${chain.branches} branches, ${chain.totalTokens.toLocaleString()} tokens`
            )
            console.log(`    Started: ${chain.rootTimestamp.toLocaleString()}`)
          }
        }
      }

      // Overall statistics
      console.log('\n' + '='.repeat(80))
      console.log('OVERALL STATISTICS:')
      console.log('='.repeat(80))

      const totalStats = await this.getOverallStats()
      console.log(`Total requests with message hashes: ${totalStats.totalWithHashes}`)
      console.log(`Requests already in conversations: ${totalStats.alreadyInConversations}`)
      console.log(`Requests needing conversation assignment: ${totalStats.needingAssignment}`)
      console.log(`Unique conversation chains that would be created: ${totalStats.uniqueChains}`)
      console.log(`Total branch points detected: ${totalStats.totalBranchPoints}`)
    } catch (error) {
      console.error('Error during analysis:', error)
      throw error
    } finally {
      await this.pool.end()
    }
  }

  private async loadRequests(): Promise<Request[]> {
    const query = `
      SELECT 
        request_id,
        train_id AS "trainId",
        timestamp,
        current_message_hash,
        parent_message_hash,
        conversation_id,
        branch_id,
        model,
        total_tokens
      FROM api_requests
      ORDER BY timestamp ASC
    `

    const result = await this.pool.query(query)
    return result.rows
  }

  private buildIndices(requests: Request[]) {
    for (const request of requests) {
      // Build ID index
      this.requestsById.set(request.request_id, request)

      // Build hash index
      if (request.current_message_hash) {
        if (!this.requestsByHash.has(request.current_message_hash)) {
          this.requestsByHash.set(request.current_message_hash, [])
        }
        this.requestsByHash.get(request.current_message_hash)!.push(request)
      }
    }
  }

  private analyzeByTrainId(requests: Request[]): Map<string, ConversationAnalysis> {
    const trainIdMap = new Map<string, Request[]>()

    // Group by trainId
    for (const request of requests) {
      if (!trainIdMap.has(request.trainId)) {
        trainIdMap.set(request.trainId, [])
      }
      trainIdMap.get(request.trainId)!.push(request)
    }

    // Analyze each trainId
    const analyses = new Map<string, ConversationAnalysis>()

    for (const [trainId, trainIdRequests] of Array.from(trainIdMap.entries())) {
      analyses.set(trainId, this.analyzeTrain(trainId, trainIdRequests))
    }

    return analyses
  }

  private analyzeTrain(trainId: string, requests: Request[]): ConversationAnalysis {
    const analysis: ConversationAnalysis = {
      trainId,
      rootRequests: 0,
      totalRequests: requests.length,
      conversationChains: [],
      orphanedRequests: 0,
      duplicateParentHashes: new Map(),
    }

    const processed = new Set<string>()
    const roots: Request[] = []

    // Find roots and count parent hash occurrences
    for (const request of requests) {
      if (!request.current_message_hash) continue

      if (!request.parent_message_hash) {
        roots.push(request)
        analysis.rootRequests++
      } else {
        // Count how many requests have this as parent
        const parentRequests = this.requestsByHash.get(request.parent_message_hash) || []
    const sameTrainParents = parentRequests.filter(p => p.trainId === trainId)

    if (sameTrainParents.length === 0) {
          analysis.orphanedRequests++
        }
      }

      // Track parent hash usage
      if (request.parent_message_hash) {
        const count = analysis.duplicateParentHashes.get(request.parent_message_hash) || 0
        analysis.duplicateParentHashes.set(request.parent_message_hash, count + 1)
      }
    }

    // Analyze conversation chains starting from roots
    for (const root of roots) {
      if (processed.has(root.request_id)) continue

      const chain = this.analyzeChain(root, requests, processed)
      analysis.conversationChains.push(chain)
    }

    // Find any orphaned chains (cycles or mid-conversation entries)
    for (const request of requests) {
      if (!request.current_message_hash || processed.has(request.request_id)) continue

      // This is an orphaned chain
      const chain = this.analyzeChain(request, requests, processed)
      analysis.conversationChains.push(chain)
    }

    return analysis
  }

  private analyzeChain(
    root: Request,
    trainIdRequests: Request[],
    processed: Set<string>
  ): {
    rootRequestId: string
    rootTimestamp: Date
    chainLength: number
    branches: number
    totalTokens: number
  } {
    let chainLength = 0
    let branches = 0
    let totalTokens = 0
    const queue: Request[] = [root]
    const seen = new Set<string>()

    while (queue.length > 0) {
      const current = queue.shift()!

      if (seen.has(current.request_id)) continue

      seen.add(current.request_id)
      processed.add(current.request_id)
      chainLength++
      totalTokens += current.total_tokens || 0

      // Find children
      const children = trainIdRequests.filter(
        r => r.parent_message_hash === current.current_message_hash && !seen.has(r.request_id)
      )

      if (children.length > 1) {
        branches += children.length - 1
      }

      queue.push(...children)
    }

    return {
      rootRequestId: root.request_id,
      rootTimestamp: root.timestamp,
      chainLength,
      branches,
      totalTokens,
    }
  }

  private async getOverallStats() {
    const stats = await this.pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE current_message_hash IS NOT NULL) as total_with_hashes,
        COUNT(*) FILTER (WHERE conversation_id IS NOT NULL) as already_in_conversations,
        COUNT(*) FILTER (WHERE current_message_hash IS NOT NULL AND conversation_id IS NULL) as needing_assignment
      FROM api_requests
    `)

    // Count unique chains and branch points
    let uniqueChains = 0
    let totalBranchPoints = 0

    const allRequests = await this.loadRequests()
    const processed = new Set<string>()

    for (const request of allRequests) {
      if (!request.current_message_hash || processed.has(request.request_id)) continue

      // Check if this is a root
      if (!request.parent_message_hash || !this.requestsByHash.has(request.parent_message_hash)) {
        uniqueChains++

        // Count branch points in this chain
        const branchPoints = this.countBranchPoints(request, allRequests, new Set())
        totalBranchPoints += branchPoints
      }
    }

    return {
      totalWithHashes: parseInt(stats.rows[0].total_with_hashes),
      alreadyInConversations: parseInt(stats.rows[0].already_in_conversations),
      needingAssignment: parseInt(stats.rows[0].needing_assignment),
      uniqueChains,
      totalBranchPoints,
    }
  }

  private countBranchPoints(root: Request, allRequests: Request[], visited: Set<string>): number {
    if (visited.has(root.request_id)) return 0
    visited.add(root.request_id)

    let branchPoints = 0

    // Find children
    const children = allRequests.filter(r => r.parent_message_hash === root.current_message_hash)

    if (children.length > 1) {
      branchPoints++
    }

    // Recursively count in children
    for (const child of children) {
      branchPoints += this.countBranchPoints(child, allRequests, visited)
    }

    return branchPoints
  }
}

// Main execution
async function main() {
  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is required')
    process.exit(1)
  }

  console.log('===========================================')
  console.log('Conversation Analysis Script (Dry Run)')
  console.log('===========================================')
  console.log('This script analyzes existing requests to show what')
  console.log('conversation structure would be created.')
  console.log('No database changes will be made.')
  console.log('')

  const analyzer = new ConversationAnalyzer(databaseUrl)

  try {
    await analyzer.analyze()
  } catch (error) {
    console.error('\n❌ Analysis failed:', error)
    process.exit(1)
  }
}

// Run the script
main()
