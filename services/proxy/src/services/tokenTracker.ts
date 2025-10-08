export interface TrainTokenStats {
  inputTokens: number
  outputTokens: number
  requestCount: number
  queryEvaluationCount: number // Requests with 1 system message
  inferenceCount: number // Requests with >1 system messages
  toolCallCount: number // Total tool calls across all responses
  lastUpdated: number
}

class TokenTracker {
  private stats: Map<string, TrainTokenStats> = new Map()
  private intervalId: NodeJS.Timeout | null = null
  private startTime: number = Date.now()

  /**
   * Track token usage for a projectId
   */
  track(
    projectId: string,
    inputTokens: number = 0,
    outputTokens: number = 0,
    requestType?: 'query_evaluation' | 'inference',
    toolCallCount: number = 0
  ) {
    const current = this.stats.get(projectId) || {
      inputTokens: 0,
      outputTokens: 0,
      requestCount: 0,
      queryEvaluationCount: 0,
      inferenceCount: 0,
      toolCallCount: 0,
      lastUpdated: Date.now(),
    }

    this.stats.set(projectId, {
      inputTokens: current.inputTokens + inputTokens,
      outputTokens: current.outputTokens + outputTokens,
      requestCount: current.requestCount + 1,
      queryEvaluationCount:
        current.queryEvaluationCount + (requestType === 'query_evaluation' ? 1 : 0),
      inferenceCount: current.inferenceCount + (requestType === 'inference' ? 1 : 0),
      toolCallCount: current.toolCallCount + toolCallCount,
      lastUpdated: Date.now(),
    })
  }

  /**
   * Start periodic reporting
   */
  startReporting(intervalMs: number = 10000) {
    if (this.intervalId) {
      clearInterval(this.intervalId)
    }

    // Print initial header
    console.log('\nToken usage tracking started (reporting every 10s)')
    console.log('='.repeat(90))

    this.intervalId = setInterval(() => {
      this.printStats()
    }, intervalMs)
  }

  /**
   * Stop periodic reporting
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      console.log('\nToken usage tracking stopped')
    }
  }

  /**
   * Print current statistics
   */
  printStats() {
    if (this.stats.size === 0) {
      return // Don't print if no stats collected
    }

    const now = Date.now()
    const uptime = Math.floor((now - this.startTime) / 1000)

    console.log('\n' + '='.repeat(90))
    console.log(
      `Token Usage Report - ${new Date().toLocaleString()} (Uptime: ${this.formatUptime(uptime)})`
    )
    console.log('='.repeat(90))
    console.log(
      'Project ID'.padEnd(25) +
        'Reqs'.padStart(6) +
        'Query'.padStart(7) +
        'Infer'.padStart(7) +
        'Tools'.padStart(7) +
        'Input Tok'.padStart(12) +
        'Output Tok'.padStart(12) +
        'Total Tok'.padStart(12)
    )
    console.log('-'.repeat(90))

    let totalInput = 0
    let totalOutput = 0
    let totalRequests = 0
    let totalQueryEval = 0
    let totalInference = 0
    let totalToolCalls = 0

    // Sort trainIds alphabetically
    const sortedTrainIds = Array.from(this.stats.entries()).sort((a, b) => a[0].localeCompare(b[0]))

    for (const [projectId, stats] of sortedTrainIds) {
      const total = stats.inputTokens + stats.outputTokens
      console.log(
        projectId.padEnd(25) +
          stats.requestCount.toString().padStart(6) +
          stats.queryEvaluationCount.toString().padStart(7) +
          stats.inferenceCount.toString().padStart(7) +
          stats.toolCallCount.toString().padStart(7) +
          stats.inputTokens.toLocaleString().padStart(12) +
          stats.outputTokens.toLocaleString().padStart(12) +
          total.toLocaleString().padStart(12)
      )

      totalInput += stats.inputTokens
      totalOutput += stats.outputTokens
      totalRequests += stats.requestCount
      totalQueryEval += stats.queryEvaluationCount
      totalInference += stats.inferenceCount
      totalToolCalls += stats.toolCallCount
    }

    // Print totals
    console.log('-'.repeat(90))
    const grandTotal = totalInput + totalOutput
    console.log(
      'TOTAL'.padEnd(25) +
        totalRequests.toString().padStart(6) +
        totalQueryEval.toString().padStart(7) +
        totalInference.toString().padStart(7) +
        totalToolCalls.toString().padStart(7) +
        totalInput.toLocaleString().padStart(12) +
        totalOutput.toLocaleString().padStart(12) +
        grandTotal.toLocaleString().padStart(12)
    )
    console.log('='.repeat(90))
  }

  /**
   * Format uptime in human-readable format
   */
  private formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60

    const parts = []
    if (days > 0) {
      parts.push(`${days}d`)
    }
    if (hours > 0) {
      parts.push(`${hours}h`)
    }
    if (minutes > 0) {
      parts.push(`${minutes}m`)
    }
    parts.push(`${secs}s`)

    return parts.join(' ')
  }

  /**
   * Get current statistics (for API endpoints)
   */
  getStats(): Record<string, TrainTokenStats> {
    const result: Record<string, TrainTokenStats> = {}
    for (const [projectId, stats] of this.stats) {
      result[projectId] = { ...stats }
    }
    return result
  }

  /**
   * Reset statistics
   */
  reset() {
    this.stats.clear()
    this.startTime = Date.now()
    console.log('Token usage statistics reset')
  }

  /**
   * Stop periodic reporting
   */
  stopReporting() {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      console.log('Token usage tracking stopped')
    }
  }
}

// Create singleton instance
export const tokenTracker = new TokenTracker()
