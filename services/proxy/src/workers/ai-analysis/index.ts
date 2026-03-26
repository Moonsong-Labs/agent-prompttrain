import { AnalysisWorker } from './AnalysisWorker.js'
import { logger } from '../../middleware/logger.js'
import { AI_WORKER_CONFIG } from '@agent-prompttrain/shared/config'

let workerInstance: AnalysisWorker | null = null

export function startAnalysisWorker(): AnalysisWorker | null {
  if (workerInstance) {
    logger.warn('Analysis worker already started', { metadata: { worker: 'analysis-worker' } })
    return workerInstance
  }

  if (!AI_WORKER_CONFIG.ENABLED) {
    logger.info('AI Analysis Worker is disabled by configuration', {
      metadata: { worker: 'analysis-worker' },
    })
    return null
  }

  // Validate configuration before starting
  if (!process.env.AI_ANALYSIS_PROJECT_ID) {
    const error = new Error('AI_ANALYSIS_PROJECT_ID is not set in environment variables')
    logger.error(
      'FATAL: AI_WORKER_ENABLED is true, but AI_ANALYSIS_PROJECT_ID is not set. Create a dedicated project for AI analysis and set its project ID.',
      {
        metadata: {
          worker: 'analysis-worker',
          AI_ANALYSIS_PROJECT_ID: 'NOT SET',
        },
      }
    )
    throw error
  }

  workerInstance = new AnalysisWorker()
  workerInstance.start()

  return workerInstance
}

export function getAnalysisWorker(): AnalysisWorker | null {
  return workerInstance
}

export { AnalysisWorker }
