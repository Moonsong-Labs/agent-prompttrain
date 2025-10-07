import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import {
  getErrorMessage,
  type CreateAnalysisRequest,
  type GetAnalysisResponse,
  getAnalysisPromptTemplate,
} from '@agent-prompttrain/shared'
import { container } from '../../container.js'
import { logger } from '../../middleware/logger.js'
import { escapeHtml, escapeHtmlArray } from '../../utils/html.js'
import { csrfProtection } from '../../middleware/csrf.js'

import { ProxyApiClient } from '../../services/api-client.js'

// SVG Icons for analysis sections
const ICONS = {
  summary: `<svg xmlns="http://www.w3.org/2000/svg" style="width: 1.25rem; height: 1.25rem; color: #6b7280;" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h7" /></svg>`,
  keyTopics: `<svg xmlns="http://www.w3.org/2000/svg" style="width: 1.25rem; height: 1.25rem; color: #6b7280;" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" /></svg>`,
  sentiment: `<svg xmlns="http://www.w3.org/2000/svg" style="width: 1.25rem; height: 1.25rem; color: #6b7280;" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>`,
  actionItems: `<svg xmlns="http://www.w3.org/2000/svg" style="width: 1.25rem; height: 1.25rem; color: #6b7280;" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>`,
  outcomes: `<svg xmlns="http://www.w3.org/2000/svg" style="width: 1.25rem; height: 1.25rem; color: #6b7280;" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" /></svg>`,
  userIntent: `<svg xmlns="http://www.w3.org/2000/svg" style="width: 1.25rem; height: 1.25rem; color: #6b7280;" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>`,
  technicalDetails: `<svg xmlns="http://www.w3.org/2000/svg" style="width: 1.25rem; height: 1.25rem; color: #6b7280;" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>`,
  conversationQuality: `<svg xmlns="http://www.w3.org/2000/svg" style="width: 1.25rem; height: 1.25rem; color: #6b7280;" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>`,
  promptingTips: `<svg xmlns="http://www.w3.org/2000/svg" style="width: 1.25rem; height: 1.25rem; color: #6b7280;" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>`,
  interactionPatterns: `<svg xmlns="http://www.w3.org/2000/svg" style="width: 1.25rem; height: 1.25rem; color: #6b7280;" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 12l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>`,
}

export const analysisPartialsRoutes = new Hono<{
  Variables: {
    apiClient?: ProxyApiClient
    csrfToken?: string
    auth?: { isAuthenticated: boolean; principal: string; source: 'dev' | 'sso' }
  }
}>()

// Apply CSRF protection to all routes
analysisPartialsRoutes.use('*', csrfProtection())

/**
 * Get the current status of an analysis and render the appropriate partial
 */
analysisPartialsRoutes.get('/status/:conversationId/:branchId', async c => {
  const { conversationId, branchId } = c.req.param()
  const pollCount = parseInt(c.req.query('pollCount') || '0')
  const apiClient = c.get('apiClient') || container.getApiClient()
  const auth = c.get('auth') || { isAuthenticated: false, principal: '', source: 'sso' as const }

  try {
    // Get analysis status from API
    const response = await apiClient.get<GetAnalysisResponse>(
      `/api/analyses/${conversationId}/${branchId}`
    )

    // Log the response for debugging
    logger.debug('Analysis status response', {
      metadata: {
        conversationId,
        branchId,
        status: response.status,
        hasContent:
          response.status === 'completed' && 'content' in response ? !!response.content : false,
        hasData: response.status === 'completed' && 'data' in response ? !!response.data : false,
      },
    })

    // Skip this check - we'll handle it in the switch statement below

    // Render appropriate state based on status
    switch (response.status) {
      case 'pending':
      case 'processing':
        return c.html(renderProcessingPanel(conversationId, branchId, pollCount))
      case 'completed':
        return c.html(renderCompletedPanel(conversationId, branchId, response, auth))
      case 'failed':
        return c.html(renderFailedPanel(conversationId, branchId, response.error, auth))
      default:
        return c.html(renderIdlePanel(conversationId, branchId, auth))
    }
  } catch (error: any) {
    // If it's a 404, the analysis doesn't exist yet - show idle panel
    if (error?.status === 404) {
      return c.html(renderIdlePanel(conversationId, branchId, auth))
    }

    logger.error('Failed to get analysis status', {
      error: getErrorMessage(error),
      metadata: {
        conversationId,
        branchId,
      },
    })
    return c.html(renderErrorPanel('Failed to load analysis status'))
  }
})

/**
 * Handle analysis generation request
 */
analysisPartialsRoutes.post('/generate/:conversationId/:branchId', async c => {
  const { conversationId, branchId } = c.req.param()
  const apiClient = c.get('apiClient') || container.getApiClient()

  try {
    // Get form data
    const formData = await c.req.parseBody()
    const customPrompt = formData.customPrompt as string | undefined

    // Create analysis request
    const requestData: CreateAnalysisRequest = {
      conversationId,
      branchId,
      ...(customPrompt && { customPrompt }),
    }

    try {
      await apiClient.post('/api/analyses', requestData)
      // Analysis created successfully - show processing state
      return c.html(renderProcessingPanel(conversationId, branchId, 0))
    } catch (postError: any) {
      // Check if it's a 409 conflict
      if (postError?.status === 409 && postError?.data) {
        interface ConflictErrorData {
          analysis: GetAnalysisResponse
        }
        const conflictData = postError.data as ConflictErrorData
        const analysis = conflictData.analysis

        if (analysis.status === 'pending' || analysis.status === 'processing') {
          return c.html(renderProcessingPanel(conversationId, branchId, 0))
        } else if (analysis.status === 'completed') {
          return c.html(renderCompletedPanel(conversationId, branchId, analysis))
        }
      }
      throw postError
    }
  } catch (error) {
    logger.error('Failed to generate analysis', {
      error: getErrorMessage(error),
      metadata: {
        conversationId,
        branchId,
      },
    })
    return c.html(renderFailedPanel(conversationId, branchId, 'Failed to generate analysis'))
  }
})

/**
 * Handle analysis regeneration request
 */
analysisPartialsRoutes.post('/regenerate/:conversationId/:branchId', async c => {
  const { conversationId, branchId } = c.req.param()
  const apiClient = c.get('apiClient') || container.getApiClient()

  try {
    // Get form data
    const formData = await c.req.parseBody()
    const customPrompt = formData.customPrompt as string | undefined

    // Regenerate analysis
    await apiClient.post(
      `/api/analyses/${conversationId}/${branchId}/regenerate`,
      customPrompt ? { customPrompt } : {}
    )

    // Show processing state
    return c.html(renderProcessingPanel(conversationId, branchId, 0))
  } catch (error) {
    logger.error('Failed to regenerate analysis', {
      error: getErrorMessage(error),
      metadata: {
        conversationId,
        branchId,
      },
    })
    return c.html(renderFailedPanel(conversationId, branchId, 'Failed to regenerate analysis'))
  }
})

// Render functions for different states

function renderIdlePanel(
  conversationId: string,
  branchId: string,
  _auth?: { isAuthenticated: boolean; principal: string; source: 'dev' | 'sso' }
) {
  const defaultPrompt = getAnalysisPromptTemplate()
  const promptId = `prompt-${conversationId}-${branchId}`.replace(/[^a-zA-Z0-9-]/g, '-')

  return html`
    <div id="analysis-panel" class="section">
      <div class="section-header" style="display: flex; align-items: center; gap: 0.75rem;">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          style="width: 1.25rem; height: 1.25rem; color: #6b7280;"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
          />
        </svg>
        <h3 style="margin: 0; font-size: 1.125rem; font-weight: 600; color: #1f2937;">
          AI Analysis
        </h3>
      </div>
      <div class="section-content">
        <p style="color: #6b7280; margin-bottom: 1.5rem; line-height: 1.6;">
          Get AI-powered insights for this conversation branch to understand patterns, key topics,
          and actionable recommendations.
        </p>

        <!-- Collapsible Prompt Editor -->
        <details style="margin-bottom: 1.5rem;">
          <summary
            style="cursor: pointer; color: #4b5563; font-size: 0.875rem; margin-bottom: 0.75rem;"
          >
            <span style="display: inline-flex; align-items: center; gap: 0.25rem;">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                style="width: 1rem; height: 1rem;"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
                />
              </svg>
              Customize Analysis Prompt
            </span>
          </summary>
          <div style="margin-top: 0.75rem;">
            <label
              for="${promptId}"
              style="display: block; font-size: 0.875rem; font-weight: 500; color: #374151; margin-bottom: 0.5rem;"
            >
              Analysis Prompt Template
            </label>
            <textarea
              id="${promptId}"
              name="customPrompt"
              rows="10"
              style="width: 100%; padding: 0.75rem; border: 1px solid #d1d5db; border-radius: 0.375rem; font-size: 0.875rem; font-family: monospace; resize: vertical;"
              placeholder="Enter custom analysis prompt..."
            >
${defaultPrompt}</textarea
            >
            <p style="margin-top: 0.5rem; font-size: 0.75rem; color: #6b7280;">
              This prompt will be sent to the AI model to analyze the conversation. You can
              customize it to focus on specific aspects or change the output format.
            </p>
          </div>
        </details>

        <button
          ${raw(`hx-post="/partials/analysis/generate/${conversationId}/${branchId}"`)}
          ${raw('hx-target="#analysis-panel"')}
          ${raw('hx-swap="outerHTML"')}
          ${raw(`hx-include="#${promptId}"`)}
          class="btn"
          style="display: inline-flex; align-items: center; gap: 0.5rem;"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            style="width: 1rem; height: 1rem;"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M13 10V3L4 14h7v7l9-11h-7z"
            />
          </svg>
          Generate AI Analysis
        </button>
      </div>
    </div>
  `
}

function renderProcessingPanel(conversationId: string, branchId: string, pollCount: number = 0) {
  // Progressive backoff: 2s, 3s, 5s, 10s, then every 10s
  const pollIntervals = [2, 3, 5, 10, 10]
  const interval = pollIntervals[Math.min(pollCount, pollIntervals.length - 1)]

  return html`
    <div
      id="analysis-panel"
      class="section"
      hx-get="/partials/analysis/status/${conversationId}/${branchId}?pollCount=${pollCount + 1}"
      hx-trigger="delay:${interval}s"
      hx-swap="outerHTML"
    >
      <div class="section-header" style="display: flex; align-items: center; gap: 0.75rem;">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          style="width: 1.25rem; height: 1.25rem; color: #6b7280;"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
          />
        </svg>
        <h3 style="margin: 0; font-size: 1.125rem; font-weight: 600; color: #1f2937;">
          AI Analysis
        </h3>
      </div>
      <div class="section-content">
        <div style="display: flex; align-items: center; gap: 0.75rem; color: #6b7280;">
          <span class="spinner"></span>
          <span>Analysis in progress... This may take a moment.</span>
        </div>
        <div style="margin-top: 1.5rem; padding: 1rem; background: #f9fafb; border-radius: 0.5rem;">
          <p style="font-size: 0.875rem; color: #6b7280; margin: 0;">
            The AI is analyzing the conversation to extract insights, identify patterns, and provide
            actionable recommendations.
          </p>
        </div>
      </div>
    </div>
  `
}

// Helper function to render a section with consistent styling
function renderAnalysisSection(icon: string, title: string, content: any): string {
  if (!content) {
    return ''
  }

  return `
    <div style="background: #f9fafb; border-radius: 0.5rem; padding: 1rem; margin-bottom: 1rem;">
      <div style="display: flex; align-items: flex-start; gap: 0.75rem;">
        <div style="flex-shrink: 0; margin-top: 0.125rem;">${icon}</div>
        <div style="flex: 1;">
          <h4 style="font-size: 0.875rem; font-weight: 600; color: #374151; margin: 0 0 0.5rem 0;">${title}</h4>
          <div style="color: #4b5563; font-size: 0.875rem; line-height: 1.6;">
            ${content}
          </div>
        </div>
      </div>
    </div>
  `
}

function renderCompletedPanel(
  conversationId: string,
  branchId: string,
  analysisResponse: GetAnalysisResponse,
  _auth?: { isAuthenticated: boolean; principal: string; source: 'dev' | 'sso' }
) {
  const formatDate = (date: string | Date) => {
    const d = new Date(date)
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  // Type guard to ensure we have a completed response
  if (analysisResponse.status !== 'completed') {
    return renderIdlePanel(conversationId, branchId)
  }

  // Check if we have analysis data
  if (!analysisResponse.data && !analysisResponse.content) {
    return renderIdlePanel(conversationId, branchId)
  }

  const analysisData = analysisResponse.data

  return html`
    <div id="analysis-panel" class="section">
      <div
        class="section-header"
        style="display: flex; justify-content: space-between; align-items: center;"
      >
        <div style="display: flex; align-items: center; gap: 0.75rem;">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            style="width: 1.25rem; height: 1.25rem; color: #6b7280;"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
            />
          </svg>
          <h3 style="margin: 0; font-size: 1.125rem; font-weight: 600; color: #1f2937;">
            AI Analysis
          </h3>
        </div>
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <button
            onclick="document.getElementById('regenerate-prompt-section').style.display = document.getElementById('regenerate-prompt-section').style.display === 'none' ? 'block' : 'none'"
            class="btn btn-secondary"
            style="font-size: 0.875rem; padding: 0.375rem 0.75rem; display: inline-flex; align-items: center; gap: 0.375rem;"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              style="width: 1rem; height: 1rem;"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
              />
            </svg>
            Customize
          </button>
          <button
            ${raw(`hx-post="/partials/analysis/regenerate/${conversationId}/${branchId}"`)}
            ${raw('hx-target="#analysis-panel"')}
            ${raw('hx-swap="outerHTML"')}
            ${raw('hx-include="#regenerate-prompt"')}
            class="btn btn-secondary"
            style="font-size: 0.875rem; padding: 0.375rem 0.75rem; display: inline-flex; align-items: center; gap: 0.375rem;"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              style="width: 1rem; height: 1rem;"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            Regenerate
          </button>
        </div>
      </div>

      <!-- Hidden Prompt Editor for Regeneration -->
      <div
        id="regenerate-prompt-section"
        style="display: none; padding: 1rem; background: #f3f4f6; border-bottom: 1px solid #e5e7eb;"
      >
        <label
          for="regenerate-prompt"
          style="display: block; font-size: 0.875rem; font-weight: 500; color: #374151; margin-bottom: 0.5rem;"
        >
          Analysis Prompt Template
        </label>
        <textarea
          id="regenerate-prompt"
          name="customPrompt"
          rows="10"
          style="width: 100%; padding: 0.75rem; border: 1px solid #d1d5db; border-radius: 0.375rem; font-size: 0.875rem; font-family: monospace; resize: vertical;"
          placeholder="Enter custom analysis prompt..."
        >
${getAnalysisPromptTemplate()}</textarea
        >
        <p style="margin-top: 0.5rem; font-size: 0.75rem; color: #6b7280;">
          Customize the prompt to focus on specific aspects or change the output format for
          regeneration.
        </p>
      </div>

      <div class="section-content">
        ${analysisData?.summary
          ? raw(
              renderAnalysisSection(
                ICONS.summary,
                'Summary',
                html`<p style="margin: 0;">${escapeHtml(analysisData.summary)}</p>`
              )
            )
          : ''}
        ${analysisData?.keyTopics && analysisData.keyTopics.length > 0
          ? raw(
              renderAnalysisSection(
                ICONS.keyTopics,
                'Key Topics',
                html`
                  <div style="display: flex; flex-wrap: wrap; gap: 0.5rem;">
                    ${escapeHtmlArray(analysisData.keyTopics).map(
                      (topic: string) => html`
                        <span
                          style="display: inline-block; background: #e5e7eb; color: #374151; padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.813rem;"
                        >
                          ${topic}
                        </span>
                      `
                    )}
                  </div>
                `
              )
            )
          : ''}
        ${analysisData?.sentiment
          ? raw(
              renderAnalysisSection(
                ICONS.sentiment,
                'Sentiment',
                html`<p style="margin: 0;">${escapeHtml(analysisData.sentiment)}</p>`
              )
            )
          : ''}
        ${analysisData?.actionItems && analysisData.actionItems.length > 0
          ? raw(
              renderAnalysisSection(
                ICONS.actionItems,
                'Action Items',
                html`
                  <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                    ${analysisData.actionItems.map((item: any) => {
                      const typeColors: Record<string, string> = {
                        task: '#3b82f6',
                        prompt_improvement: '#8b5cf6',
                        follow_up: '#f59e0b',
                      }
                      const priorityIcons: Record<string, string> = {
                        high: '🔴',
                        medium: '🟡',
                        low: '🟢',
                      }
                      return html`
                        <div
                          style="display: flex; align-items: flex-start; gap: 0.5rem; padding: 0.75rem; background: white; border-radius: 0.375rem; border: 1px solid #e5e7eb;"
                        >
                          <span
                            style="color: ${typeColors[item.type] ||
                            '#6b7280'}; font-size: 0.75rem; font-weight: 600; text-transform: uppercase;"
                            >${item.type?.replace('_', ' ')}</span
                          >
                          ${item.priority
                            ? html`<span title="${item.priority} priority"
                                >${priorityIcons[item.priority]}</span
                              >`
                            : ''}
                          <span style="flex: 1; font-size: 0.875rem;"
                            >${escapeHtml(item.description || item)}</span
                          >
                        </div>
                      `
                    })}
                  </div>
                `
              )
            )
          : ''}
        ${analysisData?.outcomes && analysisData.outcomes.length > 0
          ? raw(
              renderAnalysisSection(
                ICONS.outcomes,
                'Outcomes',
                html`
                  <ul style="margin: 0; padding-left: 1.25rem; list-style-type: disc;">
                    ${escapeHtmlArray(analysisData.outcomes).map(
                      (outcome: string) =>
                        html`<li style="margin-bottom: 0.375rem;">${outcome}</li>`
                    )}
                  </ul>
                `
              )
            )
          : ''}
        ${analysisData?.userIntent
          ? raw(
              renderAnalysisSection(
                ICONS.userIntent,
                'User Intent',
                html`<p style="margin: 0;">${escapeHtml(analysisData.userIntent)}</p>`
              )
            )
          : ''}
        ${analysisData?.promptingTips && analysisData.promptingTips.length > 0
          ? raw(
              renderAnalysisSection(
                ICONS.promptingTips,
                'Prompting Tips',
                html`
                  <div style="display: flex; flex-direction: column; gap: 1rem;">
                    ${analysisData.promptingTips.map(
                      (tip: any) => html`
                        <div
                          style="background: #fef3c7; border: 1px solid #fcd34d; border-radius: 0.5rem; padding: 1rem;"
                        >
                          <div
                            style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;"
                          >
                            <span
                              style="background: #f59e0b; color: white; font-size: 0.75rem; font-weight: 600; padding: 0.125rem 0.5rem; border-radius: 0.25rem;"
                            >
                              ${tip.category}
                            </span>
                          </div>
                          <p style="margin: 0 0 0.5rem 0; font-weight: 500; color: #92400e;">
                            ${escapeHtml(tip.issue)}
                          </p>
                          <p style="margin: 0 0 0.5rem 0; color: #78350f;">
                            💡 ${escapeHtml(tip.suggestion)}
                          </p>
                          ${tip.example
                            ? html`
                                <div
                                  style="background: white; border: 1px solid #fcd34d; border-radius: 0.375rem; padding: 0.75rem; margin-top: 0.5rem;"
                                >
                                  <p
                                    style="margin: 0 0 0.25rem 0; font-size: 0.75rem; color: #92400e; font-weight: 600;"
                                  >
                                    Example:
                                  </p>
                                  <code style="font-size: 0.813rem; color: #451a03;"
                                    >${escapeHtml(tip.example)}</code
                                  >
                                </div>
                              `
                            : ''}
                        </div>
                      `
                    )}
                  </div>
                `
              )
            )
          : ''}
        ${analysisData?.interactionPatterns
          ? raw(
              renderAnalysisSection(
                ICONS.interactionPatterns,
                'Interaction Patterns',
                html`
                  <div>
                    <div
                      style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1rem;"
                    >
                      <div
                        style="background: white; padding: 0.75rem; border-radius: 0.375rem; border: 1px solid #e5e7eb;"
                      >
                        <span style="font-size: 0.75rem; color: #6b7280; display: block;"
                          >Prompt Clarity</span
                        >
                        <div style="display: flex; align-items: center; gap: 0.5rem;">
                          <span style="font-size: 1.25rem; font-weight: 600; color: #1f2937;">
                            ${analysisData.interactionPatterns.promptClarity}/10
                          </span>
                          <div
                            style="flex: 1; height: 0.5rem; background: #e5e7eb; border-radius: 0.25rem; overflow: hidden;"
                          >
                            <div
                              style="height: 100%; background: #3b82f6; width: ${analysisData
                                .interactionPatterns.promptClarity * 10}%;"
                            ></div>
                          </div>
                        </div>
                      </div>
                      <div
                        style="background: white; padding: 0.75rem; border-radius: 0.375rem; border: 1px solid #e5e7eb;"
                      >
                        <span style="font-size: 0.75rem; color: #6b7280; display: block;"
                          >Context Completeness</span
                        >
                        <div style="display: flex; align-items: center; gap: 0.5rem;">
                          <span style="font-size: 1.25rem; font-weight: 600; color: #1f2937;">
                            ${analysisData.interactionPatterns.contextCompleteness}/10
                          </span>
                          <div
                            style="flex: 1; height: 0.5rem; background: #e5e7eb; border-radius: 0.25rem; overflow: hidden;"
                          >
                            <div
                              style="height: 100%; background: #10b981; width: ${analysisData
                                .interactionPatterns.contextCompleteness * 10}%;"
                            ></div>
                          </div>
                        </div>
                      </div>
                      <div
                        style="background: white; padding: 0.75rem; border-radius: 0.375rem; border: 1px solid #e5e7eb;"
                      >
                        <span style="font-size: 0.75rem; color: #6b7280; display: block;"
                          >Follow-up Effectiveness</span
                        >
                        <span
                          style="font-size: 0.875rem; font-weight: 600; color: #1f2937; text-transform: capitalize;"
                        >
                          ${analysisData.interactionPatterns.followUpEffectiveness}
                        </span>
                      </div>
                    </div>
                    ${analysisData.interactionPatterns.commonIssues?.length > 0
                      ? html`
                          <div style="margin-bottom: 0.75rem;">
                            <h5
                              style="font-size: 0.813rem; font-weight: 600; color: #dc2626; margin: 0 0 0.375rem 0;"
                            >
                              Common Issues to Address
                            </h5>
                            <ul style="margin: 0; padding-left: 1.25rem; list-style-type: disc;">
                              ${escapeHtmlArray(analysisData.interactionPatterns.commonIssues).map(
                                (issue: string) =>
                                  html`<li
                                    style="margin-bottom: 0.25rem; font-size: 0.813rem; color: #7f1d1d;"
                                  >
                                    ${issue}
                                  </li>`
                              )}
                            </ul>
                          </div>
                        `
                      : ''}
                    ${analysisData.interactionPatterns.strengths?.length > 0
                      ? html`
                          <div>
                            <h5
                              style="font-size: 0.813rem; font-weight: 600; color: #059669; margin: 0 0 0.375rem 0;"
                            >
                              Strengths to Continue
                            </h5>
                            <ul style="margin: 0; padding-left: 1.25rem; list-style-type: disc;">
                              ${escapeHtmlArray(analysisData.interactionPatterns.strengths).map(
                                (strength: string) =>
                                  html`<li
                                    style="margin-bottom: 0.25rem; font-size: 0.813rem; color: #064e3b;"
                                  >
                                    ${strength}
                                  </li>`
                              )}
                            </ul>
                          </div>
                        `
                      : ''}
                  </div>
                `
              )
            )
          : ''}
        ${analysisData?.technicalDetails &&
        (analysisData.technicalDetails.frameworks.length > 0 ||
          analysisData.technicalDetails.issues.length > 0 ||
          analysisData.technicalDetails.solutions.length > 0)
          ? raw(
              renderAnalysisSection(
                ICONS.technicalDetails,
                'Technical Details',
                html`
                  ${analysisData.technicalDetails.frameworks.length > 0
                    ? html`
                        <div style="margin-bottom: 0.875rem;">
                          <h5
                            style="font-size: 0.813rem; font-weight: 600; color: #6b7280; margin: 0 0 0.375rem 0;"
                          >
                            Frameworks & Technologies
                          </h5>
                          <div style="display: flex; flex-wrap: wrap; gap: 0.375rem;">
                            ${escapeHtmlArray(analysisData.technicalDetails.frameworks).map(
                              (framework: string) => html`
                                <span
                                  style="display: inline-block; background: #ddd6fe; color: #5b21b6; padding: 0.125rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem;"
                                >
                                  ${framework}
                                </span>
                              `
                            )}
                          </div>
                        </div>
                      `
                    : ''}
                  ${analysisData.technicalDetails.issues.length > 0
                    ? html`
                        <div style="margin-bottom: 0.875rem;">
                          <h5
                            style="font-size: 0.813rem; font-weight: 600; color: #6b7280; margin: 0 0 0.375rem 0;"
                          >
                            Issues Encountered
                          </h5>
                          <ul style="margin: 0; padding-left: 1.25rem; list-style-type: disc;">
                            ${escapeHtmlArray(analysisData.technicalDetails.issues).map(
                              (issue: string) =>
                                html`<li style="margin-bottom: 0.25rem; font-size: 0.813rem;">
                                  ${issue}
                                </li>`
                            )}
                          </ul>
                        </div>
                      `
                    : ''}
                  ${analysisData.technicalDetails.solutions.length > 0
                    ? html`
                        <div style="margin-bottom: 0.875rem;">
                          <h5
                            style="font-size: 0.813rem; font-weight: 600; color: #6b7280; margin: 0 0 0.375rem 0;"
                          >
                            Solutions
                          </h5>
                          <ul style="margin: 0; padding-left: 1.25rem; list-style-type: disc;">
                            ${escapeHtmlArray(analysisData.technicalDetails.solutions).map(
                              (solution: string) =>
                                html`<li style="margin-bottom: 0.25rem; font-size: 0.813rem;">
                                  ${solution}
                                </li>`
                            )}
                          </ul>
                        </div>
                      `
                    : ''}
                  ${analysisData.technicalDetails.toolUsageEfficiency ||
                  analysisData.technicalDetails.contextWindowManagement
                    ? html`
                        <div
                          style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem;"
                        >
                          ${analysisData.technicalDetails.toolUsageEfficiency
                            ? html`
                                <div
                                  style="background: white; padding: 0.5rem; border-radius: 0.25rem; border: 1px solid #e5e7eb;"
                                >
                                  <span style="font-size: 0.75rem; color: #6b7280; display: block;"
                                    >Tool Usage</span
                                  >
                                  <span
                                    style="font-size: 0.813rem; font-weight: 600; color: #1f2937; text-transform: capitalize;"
                                  >
                                    ${analysisData.technicalDetails.toolUsageEfficiency}
                                  </span>
                                </div>
                              `
                            : ''}
                          ${analysisData.technicalDetails.contextWindowManagement
                            ? html`
                                <div
                                  style="background: white; padding: 0.5rem; border-radius: 0.25rem; border: 1px solid #e5e7eb;"
                                >
                                  <span style="font-size: 0.75rem; color: #6b7280; display: block;"
                                    >Context Management</span
                                  >
                                  <span
                                    style="font-size: 0.813rem; font-weight: 600; color: #1f2937; text-transform: capitalize;"
                                  >
                                    ${analysisData.technicalDetails.contextWindowManagement}
                                  </span>
                                </div>
                              `
                            : ''}
                        </div>
                      `
                    : ''}
                `
              )
            )
          : ''}
        ${analysisData?.conversationQuality
          ? raw(
              renderAnalysisSection(
                ICONS.conversationQuality,
                'Conversation Quality',
                html`
                  <div
                    style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem;"
                  >
                    <div
                      style="background: white; padding: 0.75rem; border-radius: 0.375rem; border: 1px solid #e5e7eb;"
                    >
                      <span style="font-size: 0.75rem; color: #6b7280; display: block;"
                        >Clarity</span
                      >
                      <span
                        style="font-size: 0.875rem; font-weight: 600; color: #1f2937; text-transform: capitalize;"
                      >
                        ${analysisData.conversationQuality.clarity}
                      </span>
                      ${analysisData.conversationQuality.clarityImprovement
                        ? html`
                            <p
                              style="margin: 0.5rem 0 0 0; font-size: 0.75rem; color: #6b7280; font-style: italic;"
                            >
                              ${escapeHtml(analysisData.conversationQuality.clarityImprovement)}
                            </p>
                          `
                        : ''}
                    </div>
                    <div
                      style="background: white; padding: 0.75rem; border-radius: 0.375rem; border: 1px solid #e5e7eb;"
                    >
                      <span style="font-size: 0.75rem; color: #6b7280; display: block;"
                        >Completeness</span
                      >
                      <span
                        style="font-size: 0.875rem; font-weight: 600; color: #1f2937; text-transform: capitalize;"
                      >
                        ${analysisData.conversationQuality.completeness}
                      </span>
                      ${analysisData.conversationQuality.completenessImprovement
                        ? html`
                            <p
                              style="margin: 0.5rem 0 0 0; font-size: 0.75rem; color: #6b7280; font-style: italic;"
                            >
                              ${escapeHtml(
                                analysisData.conversationQuality.completenessImprovement
                              )}
                            </p>
                          `
                        : ''}
                    </div>
                    <div
                      style="background: white; padding: 0.75rem; border-radius: 0.375rem; border: 1px solid #e5e7eb;"
                    >
                      <span style="font-size: 0.75rem; color: #6b7280; display: block;"
                        >Effectiveness</span
                      >
                      <span
                        style="font-size: 0.875rem; font-weight: 600; color: #1f2937; text-transform: capitalize;"
                      >
                        ${analysisData.conversationQuality.effectiveness}
                      </span>
                      ${analysisData.conversationQuality.effectivenessImprovement
                        ? html`
                            <p
                              style="margin: 0.5rem 0 0 0; font-size: 0.75rem; color: #6b7280; font-style: italic;"
                            >
                              ${escapeHtml(
                                analysisData.conversationQuality.effectivenessImprovement
                              )}
                            </p>
                          `
                        : ''}
                    </div>
                  </div>
                `
              )
            )
          : ''}
        ${!analysisData && analysisResponse.content
          ? html`
              <div style="background: #f9fafb; border-radius: 0.5rem; padding: 1rem;">
                <p
                  style="color: #4b5563; white-space: pre-wrap; margin: 0; font-size: 0.875rem; line-height: 1.6;"
                >
                  ${escapeHtml(analysisResponse.content) || 'No analysis content available.'}
                </p>
              </div>
            `
          : ''}
        ${!analysisData && !analysisResponse.content
          ? html`
              <div style="text-align: center; padding: 2rem; color: #9ca3af;">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  style="height: 3rem; width: 3rem; margin: 0 auto 0.5rem auto;"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="1"
                    d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
                  />
                </svg>
                <p style="font-size: 0.875rem;">No analysis content available.</p>
              </div>
            `
          : ''}

        <div
          style="margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid #e5e7eb; font-size: 0.75rem; color: #9ca3af;"
        >
          <div
            style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem;"
          >
            <div style="display: flex; align-items: center; gap: 0.375rem;">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                style="width: 0.875rem; height: 0.875rem;"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <span>Generated: ${formatDate(analysisResponse.completedAt || new Date())}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
}

function renderFailedPanel(
  conversationId: string,
  branchId: string,
  errorMessage?: string | null,
  _auth?: { isAuthenticated: boolean; principal: string; source: 'dev' | 'sso' }
) {
  return html`
    <div id="analysis-panel" class="section">
      <div class="section-header" style="display: flex; align-items: center; gap: 0.75rem;">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          style="width: 1.25rem; height: 1.25rem; color: #ef4444;"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <h3 style="margin: 0; font-size: 1.125rem; font-weight: 600; color: #1f2937;">
          AI Analysis Failed
        </h3>
      </div>
      <div class="section-content">
        <div
          style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 0.5rem; padding: 1rem; margin-bottom: 1.5rem;"
        >
          <div style="display: flex; align-items: flex-start; gap: 0.75rem;">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              style="width: 1.25rem; height: 1.25rem; color: #dc2626; flex-shrink: 0;"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <div>
              <p style="font-weight: 600; color: #b91c1c; margin: 0;">Analysis Failed</p>
              ${errorMessage
                ? html`<p style="margin: 0.5rem 0 0 0; color: #991b1b; font-size: 0.875rem;">
                    ${escapeHtml(errorMessage)}
                  </p>`
                : html`<p style="margin: 0.5rem 0 0 0; color: #991b1b; font-size: 0.875rem;">
                    An error occurred while analyzing the conversation.
                  </p>`}
            </div>
          </div>
        </div>
        <button
          ${raw(`hx-post="/partials/analysis/generate/${conversationId}/${branchId}"`)}
          ${raw('hx-target="#analysis-panel"')}
          ${raw('hx-swap="outerHTML"')}
          class="btn"
          style="display: inline-flex; align-items: center; gap: 0.5rem;"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            style="width: 1rem; height: 1rem;"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          Try Again
        </button>
      </div>
    </div>
  `
}

function renderErrorPanel(message: string) {
  return html`
    <div id="analysis-panel" class="section">
      <div class="section-header" style="display: flex; align-items: center; gap: 0.75rem;">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          style="width: 1.25rem; height: 1.25rem; color: #ef4444;"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <h3 style="margin: 0; font-size: 1.125rem; font-weight: 600; color: #1f2937;">Error</h3>
      </div>
      <div class="section-content">
        <div
          style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 0.5rem; padding: 1rem;"
        >
          <p style="color: #991b1b; margin: 0; font-size: 0.875rem;">${escapeHtml(message)}</p>
        </div>
      </div>
    </div>
  `
}
