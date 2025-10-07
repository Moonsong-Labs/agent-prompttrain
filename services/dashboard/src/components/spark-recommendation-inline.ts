// No need for hono/html since we're returning raw HTML strings
import { escapeHtml } from '../utils/formatters.js'
import { marked } from 'marked'
import sanitizeHtml from 'sanitize-html'
import type { SparkRecommendation } from '../utils/spark.js'

/**
 * Render a Spark recommendation inline in conversation view
 */
export async function renderSparkRecommendationInline(
  recommendation: SparkRecommendation,
  sessionId: string,
  messageIndex: number,
  existingFeedback?: Record<string, unknown>
): Promise<string> {
  // Render markdown content
  const dirtyHtml = await marked.parse(recommendation.response)
  const htmlContent = sanitizeHtml(dirtyHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'pre',
      'code',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
    ]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      code: ['class'],
      pre: ['class'],
      td: ['align'],
      th: ['align'],
    },
  })

  const contentId = `spark-inline-content-${sessionId}`
  const feedbackId = `spark-inline-feedback-${sessionId}`
  const hasFeedback = !!existingFeedback

  return `
    <div class="spark-inline-recommendation" data-session-id="${sessionId}">
      <!-- Fancy Header -->
      <div class="spark-inline-header">
        <div class="spark-inline-title">
          <span class="spark-icon">✨</span>
          <span class="spark-label">Spark Recommendation</span>
          ${hasFeedback ? '<span class="feedback-badge-inline">✅ Rated</span>' : ''}
        </div>
        <div class="spark-inline-meta">
          <code class="session-id">${sessionId}</code>
        </div>
      </div>

      <!-- Query and Context Display -->
      ${
        recommendation.query || recommendation.context
          ? `
        <div class="spark-inline-request">
          ${
            recommendation.query
              ? `
            <div class="spark-query">
              <span class="label">Query:</span>
              <span class="value">${escapeHtml(recommendation.query)}</span>
            </div>
          `
              : ''
          }
          ${
            recommendation.context
              ? `
            <div class="spark-context">
              <span class="label">Context:</span>
              <span class="value">
                ${
                  Array.isArray(recommendation.context)
                    ? recommendation.context.map(c => escapeHtml(c)).join(' • ')
                    : escapeHtml(recommendation.context)
                }
              </span>
            </div>
          `
              : ''
          }
        </div>
      `
          : ''
      }

      <!-- Recommendation Content -->
      <div class="spark-inline-content" id="${contentId}">
        ${htmlContent}
      </div>

      <!-- Feedback Dropdown -->
      <div class="spark-inline-feedback-wrapper">
        <button
          class="spark-feedback-toggle"
          onclick="toggleSparkFeedback('${sessionId}')"
        >
          <span class="toggle-icon">▼</span>
          ${hasFeedback ? 'View Feedback' : 'Add Feedback'}
        </button>

        <div class="spark-inline-feedback" id="${feedbackId}" style="display: none;">
          ${hasFeedback ? renderInlineExistingFeedback(existingFeedback) : renderInlineFeedbackForm(sessionId)}
        </div>
      </div>
    </div>

    <style>
      .spark-inline-recommendation {
        background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
        border: 1px solid #7dd3fc;
        border-radius: 0.75rem;
        margin: 1rem 0;
        overflow: hidden;
      }

      .spark-inline-header {
        background: linear-gradient(135deg, #0284c7 0%, #0ea5e9 100%);
        color: white;
        padding: 0.75rem 1rem;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .spark-inline-title {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-weight: 600;
      }

      .spark-icon {
        font-size: 1.25rem;
      }

      .spark-label {
        font-size: 0.9375rem;
      }

      .feedback-badge-inline {
        background: rgba(255, 255, 255, 0.2);
        padding: 0.125rem 0.5rem;
        border-radius: 0.25rem;
        font-size: 0.75rem;
        font-weight: 500;
      }

      .spark-inline-meta {
        font-size: 0.75rem;
      }

      .session-id {
        background: rgba(255, 255, 255, 0.2);
        padding: 0.125rem 0.5rem;
        border-radius: 0.25rem;
        font-family: monospace;
      }

      .spark-inline-request {
        background: rgba(255, 255, 255, 0.7);
        padding: 0.75rem 1rem;
        border-bottom: 1px solid #e0f2fe;
        font-size: 0.875rem;
      }

      .spark-query, .spark-context {
        margin-bottom: 0.25rem;
      }

      .spark-query:last-child, .spark-context:last-child {
        margin-bottom: 0;
      }

      .spark-inline-request .label {
        font-weight: 600;
        color: #0369a1;
        margin-right: 0.5rem;
      }

      .spark-inline-request .value {
        color: #334155;
      }

      .spark-inline-content {
        padding: 1.5rem;
        background: white;
        max-height: 600px;
        overflow-y: auto;
      }

      /* Markdown styles for inline content */
      .spark-inline-content h1,
      .spark-inline-content h2,
      .spark-inline-content h3,
      .spark-inline-content h4,
      .spark-inline-content h5,
      .spark-inline-content h6 {
        margin-top: 1.25rem;
        margin-bottom: 0.75rem;
        color: #0c4a6e;
      }

      .spark-inline-content h1 { font-size: 1.5rem; }
      .spark-inline-content h2 { font-size: 1.25rem; }
      .spark-inline-content h3 { font-size: 1.125rem; }

      .spark-inline-content p {
        margin-bottom: 0.75rem;
        line-height: 1.6;
      }

      .spark-inline-content pre {
        background: #1e293b;
        color: #e2e8f0;
        padding: 1rem;
        border-radius: 0.5rem;
        overflow-x: auto;
        margin: 1rem 0;
      }

      .spark-inline-content code {
        background: #e0f2fe;
        color: #0369a1;
        padding: 0.125rem 0.375rem;
        border-radius: 0.25rem;
        font-size: 0.875em;
        font-family: 'Monaco', 'Consolas', monospace;
      }

      .spark-inline-content pre code {
        background: transparent;
        color: inherit;
        padding: 0;
      }

      .spark-inline-content table {
        width: 100%;
        border-collapse: collapse;
        margin: 1rem 0;
      }

      .spark-inline-content th,
      .spark-inline-content td {
        border: 1px solid #e0f2fe;
        padding: 0.5rem;
        text-align: left;
      }

      .spark-inline-content th {
        background: #f0f9ff;
        font-weight: 600;
        color: #0369a1;
      }

      .spark-inline-content tr:nth-child(even) {
        background: #f8fafc;
      }

      /* Feedback section */
      .spark-inline-feedback-wrapper {
        border-top: 1px solid #e0f2fe;
      }

      .spark-feedback-toggle {
        width: 100%;
        padding: 0.75rem 1rem;
        background: #f0f9ff;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        color: #0369a1;
        font-weight: 500;
        font-size: 0.875rem;
        transition: background 0.2s;
      }

      .spark-feedback-toggle:hover:not(:disabled) {
        background: #e0f2fe;
      }

      .spark-feedback-toggle:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .toggle-icon {
        transition: transform 0.2s;
      }

      .spark-feedback-toggle.expanded .toggle-icon {
        transform: rotate(180deg);
      }

      .spark-inline-feedback {
        padding: 1rem;
        background: #f8fafc;
      }

      /* Feedback form styles */
      .inline-feedback-form {
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }

      .inline-rating-group {
        display: flex;
        gap: 0.5rem;
        align-items: center;
      }

      .inline-rating-star {
        cursor: pointer;
        font-size: 1.5rem;
        color: #cbd5e1;
        transition: color 0.2s;
      }

      .inline-rating-star:hover,
      .inline-rating-star.active {
        color: #fbbf24;
      }

      .inline-feedback-textarea {
        width: 100%;
        min-height: 80px;
        padding: 0.5rem;
        border: 1px solid #e0f2fe;
        border-radius: 0.375rem;
        font-family: inherit;
        font-size: 0.875rem;
        resize: vertical;
      }

      .inline-feedback-actions {
        display: flex;
        gap: 0.5rem;
        justify-content: flex-end;
      }

      .btn-inline-primary {
        background: #0ea5e9;
        color: white;
        padding: 0.5rem 1rem;
        border: none;
        border-radius: 0.375rem;
        cursor: pointer;
        font-size: 0.875rem;
        font-weight: 500;
        transition: background 0.2s;
      }

      .btn-inline-primary:hover {
        background: #0284c7;
      }

      .btn-inline-cancel {
        background: #e2e8f0;
        color: #475569;
        padding: 0.5rem 1rem;
        border: none;
        border-radius: 0.375rem;
        cursor: pointer;
        font-size: 0.875rem;
        font-weight: 500;
        transition: background 0.2s;
      }

      .btn-inline-cancel:hover {
        background: #cbd5e1;
      }

      .inline-existing-feedback {
        background: white;
        padding: 1rem;
        border-radius: 0.375rem;
        border: 1px solid #e0f2fe;
      }

      .inline-feedback-rating {
        display: flex;
        gap: 0.25rem;
        margin-bottom: 0.5rem;
      }

      .star-filled {
        color: #fbbf24;
      }

      .star-empty {
        color: #e2e8f0;
      }
    </style>

    <script>
      // Toggle feedback section
      function toggleSparkFeedback(sessionId) {
        const feedbackEl = document.getElementById('spark-inline-feedback-' + sessionId)
        const toggleBtn = feedbackEl.previousElementSibling
        
        if (feedbackEl.style.display === 'none') {
          feedbackEl.style.display = 'block'
          toggleBtn.classList.add('expanded')
        } else {
          feedbackEl.style.display = 'none'
          toggleBtn.classList.remove('expanded')
        }
      }

      // Initialize rating stars
      document.addEventListener('DOMContentLoaded', function() {
        document.querySelectorAll('.inline-rating-star').forEach(star => {
          star.addEventListener('click', function() {
            const rating = parseInt(this.dataset.rating)
            const group = this.closest('.inline-rating-group')
            const input = group.querySelector('input[type="hidden"]')
            
            input.value = rating
            
            group.querySelectorAll('.inline-rating-star').forEach((s, i) => {
              if (i < rating) {
                s.classList.add('active')
                s.textContent = '★'
              } else {
                s.classList.remove('active')
                s.textContent = '☆'
              }
            })
          })
        })
      })


      // Submit feedback
      async function submitInlineSparkFeedback(sessionId) {
        const form = document.getElementById('inline-feedback-form-' + sessionId)
        const formData = new FormData(form)
        
        const feedback = {
          session_id: sessionId,
          feedback: {
            recommendation_feedback: {
              overall_feedback: {
                rating: parseInt(formData.get('rating')),
                comments: formData.get('comments')
              },
              section_feedbacks: [] // Required but can be empty
            },
            source_feedbacks: [], // Required but can be empty
            lessons_learned: [] // Required but can be empty
          }
        }
        
        try {
          // Send feedback through dashboard's proxy endpoint
          // This avoids CORS and authentication issues
          const response = await fetch('/dashboard/api/spark/feedback', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(feedback),
            credentials: 'same-origin'
          })
          
          if (response.ok) {
            // Replace form with success message
            const feedbackSection = document.getElementById('spark-inline-feedback-' + sessionId)
            feedbackSection.innerHTML = '<div class="inline-existing-feedback"><p>✅ Thank you for your feedback!</p></div>'
          } else {
            const errorText = await response.text()
            alert('Failed to submit feedback. Please try again.')
          }
        } catch (error) {
          console.error('Error submitting feedback:', error)
          alert('Failed to submit feedback. Please try again.')
        }
      }
    </script>
  `
}

/**
 * Render the inline feedback form
 */
function renderInlineFeedbackForm(sessionId: string): string {
  return `
    <form 
      id="inline-feedback-form-${sessionId}" 
      class="inline-feedback-form"
      onsubmit="event.preventDefault(); submitInlineSparkFeedback('${sessionId}')"
    >
      <div>
        <label style="display: block; margin-bottom: 0.5rem; font-weight: 500; color: #0369a1;">
          How helpful was this recommendation?
        </label>
        <div class="inline-rating-group">
          <input type="hidden" name="rating" value="0" required />
          ${[1, 2, 3, 4, 5]
            .map(i => `<span class="inline-rating-star" data-rating="${i}">☆</span>`)
            .join(' ')}
          <span style="margin-left: 0.5rem; font-size: 0.75rem; color: #64748b;">
            (1 = Not helpful, 5 = Very helpful)
          </span>
        </div>
      </div>

      <div>
        <label 
          for="inline-comments-${sessionId}"
          style="display: block; margin-bottom: 0.5rem; font-weight: 500; color: #0369a1;"
        >
          Comments (required)
        </label>
        <textarea
          id="inline-comments-${sessionId}"
          name="comments"
          class="inline-feedback-textarea"
          placeholder="Share your thoughts on how this recommendation could be improved..."
          required
        ></textarea>
      </div>

      <div class="inline-feedback-actions">
        <button 
          type="button" 
          class="btn-inline-cancel"
          onclick="toggleSparkFeedback('${sessionId}')"
        >
          Cancel
        </button>
        <button type="submit" class="btn-inline-primary">
          Submit Feedback
        </button>
      </div>
    </form>
  `
}

/**
 * Render existing feedback inline
 */
function renderInlineExistingFeedback(feedback: Record<string, any>): string {
  const rating = feedback.recommendation_feedback?.overall_feedback?.rating || 0
  const comments = feedback.recommendation_feedback?.overall_feedback?.comments || ''

  return `
    <div class="inline-existing-feedback">
      <h4 style="margin: 0 0 0.5rem 0; font-size: 0.875rem; color: #0369a1;">Your Feedback</h4>
      <div class="inline-feedback-rating">
        ${[1, 2, 3, 4, 5]
          .map(i => `<span class="${i <= rating ? 'star-filled' : 'star-empty'}">★</span>`)
          .join('')}
      </div>
      ${
        comments
          ? `<p style="margin: 0.5rem 0 0 0; font-size: 0.875rem; color: #334155;">${escapeHtml(
              comments
            )}</p>`
          : ''
      }
    </div>
  `
}
