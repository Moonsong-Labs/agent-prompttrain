import { Hono } from 'hono'
import { z } from 'zod'
import { getErrorMessage, config } from '@agent-prompttrain/shared'

export const sparkApiRoutes = new Hono()

// Schema definitions
const FeedbackSchema = z.object({
  rating: z.number().min(1).max(5),
  comments: z.string(),
})

const SectionFeedbackSchema = z.object({
  section_id: z.string(),
  feedback: FeedbackSchema,
})

const RecommendationFeedbackSchema = z.object({
  overall_feedback: FeedbackSchema,
  section_feedbacks: z.array(SectionFeedbackSchema).optional(),
})

const SourceFeedbackSchema = z.object({
  source_url: z.string(),
  feedback: FeedbackSchema,
})

const LessonLearnedSchema = z.object({
  situation: z.string(),
  action: z.string(),
  result: z.string(),
  learning: z.string(),
  generalized_code_example: z.string().nullable().optional(),
})

const CodeChangesSchema = z.object({
  number_of_files_created: z.number().nullable().optional(),
  number_of_files_edited: z.number().nullable().optional(),
  number_of_files_deleted: z.number().nullable().optional(),
  total_number_of_lines_added: z.number().nullable().optional(),
  total_number_of_lines_removed: z.number().nullable().optional(),
})

const IntegrationMetricsSchema = z.object({
  integration_time_seconds: z.number().nullable().optional(),
  code_changes: CodeChangesSchema.optional(),
  number_of_actions: z.number().nullable().optional(),
})

const FeedbackReportSchema = z.object({
  recommendation_feedback: RecommendationFeedbackSchema,
  source_feedbacks: z.array(SourceFeedbackSchema).optional(),
  lessons_learned: z.array(LessonLearnedSchema).optional(),
  integration_metrics: IntegrationMetricsSchema.optional(),
})

const SendFeedbackRequestSchema = z.object({
  session_id: z.string(),
  feedback: FeedbackReportSchema,
})

const BatchFeedbackRequestSchema = z.object({
  session_ids: z.array(z.string()).max(100),
})

/**
 * Get feedback for a specific session
 */
sparkApiRoutes.get('/spark/sessions/:sessionId/feedback', async c => {
  const sessionId = c.req.param('sessionId')

  if (!config.spark.enabled || !config.spark.apiUrl || !config.spark.apiKey) {
    return c.json({ error: 'Spark API not configured' }, 503)
  }

  try {
    const response = await fetch(`${config.spark.apiUrl}/sessions/${sessionId}/feedback`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.spark.apiKey}`,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}) as any)
      return c.json(
        { error: (errorData as any).detail || `Failed to get feedback: ${response.statusText}` },
        response.status as any
      )
    }

    const data = await response.json()
    return c.json(data as any)
  } catch (error) {
    console.error('Error fetching feedback:', error)
    return c.json({ error: getErrorMessage(error) || 'Failed to fetch feedback' }, 500)
  }
})

/**
 * Send feedback for a recommendation session
 */
sparkApiRoutes.post('/spark/feedback', async c => {
  if (!config.spark.enabled || !config.spark.apiUrl || !config.spark.apiKey) {
    return c.json({ error: 'Spark API not configured' }, 503)
  }

  try {
    const body = await c.req.json()
    const validatedData = SendFeedbackRequestSchema.parse(body)

    const response = await fetch(`${config.spark.apiUrl}/send_feedback`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.spark.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(validatedData),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}) as any)
      return c.json(
        { error: (errorData as any).detail || `Failed to send feedback: ${response.statusText}` },
        response.status as any
      )
    }

    const data = await response.json()
    return c.json(data as any)
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Invalid request data', details: error.errors }, 400)
    }
    console.error('Error sending feedback:', error)
    return c.json({ error: getErrorMessage(error) || 'Failed to send feedback' }, 500)
  }
})

/**
 * Get feedback for multiple sessions in batch
 */
sparkApiRoutes.post('/spark/feedback/batch', async c => {
  if (!config.spark.enabled || !config.spark.apiUrl || !config.spark.apiKey) {
    return c.json({ error: 'Spark API not configured' }, 503)
  }

  try {
    const body = await c.req.json()
    const validatedData = BatchFeedbackRequestSchema.parse(body)

    const sparkUrl = `${config.spark.apiUrl}/feedback/batch`
    const response = await fetch(sparkUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.spark.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(validatedData),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')

      let errorData: any = {}
      try {
        errorData = errorText ? JSON.parse(errorText) : {}
      } catch {
        // Not JSON
      }

      return c.json(
        {
          error:
            (errorData as any).detail ||
            errorText ||
            `Failed to fetch batch feedback: ${response.statusText}`,
        },
        response.status as any
      )
    }

    const data = await response.json()
    return c.json(data as any)
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Invalid request data', details: error.errors }, 400)
    }
    console.error('Error fetching batch feedback:', error)
    return c.json({ error: getErrorMessage(error) || 'Failed to fetch batch feedback' }, 500)
  }
})
