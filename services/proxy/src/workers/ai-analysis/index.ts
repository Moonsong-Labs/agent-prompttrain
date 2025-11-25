import { AnalysisWorker } from './AnalysisWorker.js'
import { logger } from '../../middleware/logger.js'
import { AI_WORKER_CONFIG, GEMINI_CONFIG } from '@agent-prompttrain/shared/config'

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
  if (!GEMINI_CONFIG.API_KEY) {
    const error = new Error('GEMINI_API_KEY is not set in environment variables')
    logger.error(
      'FATAL: AI_WORKER_ENABLED is true, but GEMINI_API_KEY is not set. The AI Analysis Worker cannot start.',
      {
        metadata: {
          worker: 'analysis-worker',
          GEMINI_CONFIG_API_KEY: GEMINI_CONFIG.API_KEY || 'empty',
          ENV_GEMINI_API_KEY: process.env.GEMINI_API_KEY ? 'SET' : 'NOT SET',
        },
      }
    )
    throw error
  }

  workerInstance = new AnalysisWorker()
  workerInstance.start()

  // Don't register signal handlers here - let the main process handle shutdown
  // The main process will call stop() on the worker instance

  return workerInstance
}

export function getAnalysisWorker(): AnalysisWorker | null {
  return workerInstance
}

export { AnalysisWorker }
