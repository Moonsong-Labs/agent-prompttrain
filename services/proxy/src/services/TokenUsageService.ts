import { Pool } from 'pg'
import { logger } from '../middleware/logger.js'

export interface TokenUsageData {
  accountId: string
  projectId: string
  model: string
  requestType?: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  requestCount: number
}

export interface TokenUsageWindow {
  accountId: string
  projectId: string
  model: string
  windowStart: Date
  windowEnd: Date
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  totalRequests: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

export interface DailyUsage {
  date: string
  accountId: string
  projectId: string
  model?: string
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  totalRequests: number
}

/**
 * Service for tracking and querying token usage
 * Provides persistent storage and efficient querying of token usage data
 */
export class TokenUsageService {
  constructor(private pool: Pool) {}

  /**
   * Record token usage for a request
   * Note: Token usage is now tracked directly in api_requests table
   * This method is kept for backward compatibility but does nothing
   */
  async recordUsage(_data: TokenUsageData): Promise<void> {
    // Token usage is now tracked directly in api_requests table
    // No separate recording needed
  }

  /**
   * Get token usage for a sliding window (e.g., 5 hours)
   */
  async getUsageWindow(
    accountId: string,
    windowHours: number = 5,
    projectId?: string,
    model?: string
  ): Promise<TokenUsageWindow> {
    try {
      let query = `
        SELECT 
          $1::varchar as account_id,
          COALESCE($2::varchar, 'all') as project_id,
          COALESCE($3::varchar, 'all') as model,
          NOW() - ($4 * INTERVAL '1 hour') as window_start,
          NOW() as window_end,
          COALESCE(SUM(input_tokens), 0) as total_input_tokens,
          COALESCE(SUM(output_tokens), 0) as total_output_tokens,
          COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
          COUNT(*) as total_requests,
          COALESCE(SUM(cache_creation_input_tokens), 0) as cache_creation_input_tokens,
          COALESCE(SUM(cache_read_input_tokens), 0) as cache_read_input_tokens
        FROM api_requests
        WHERE account_id = $1
          AND timestamp >= NOW() - ($4 * INTERVAL '1 hour')
          AND timestamp < NOW()
      `

      const values: any[] = [accountId, projectId || '', model || '', windowHours]

      if (projectId) {
        query += ` AND project_id = $2`
      }

      if (model) {
        query += ` AND model = $3`
      }

      const result = await this.pool.query(query, values)

      if (result.rows.length === 0) {
        // Return empty usage
        return {
          accountId,
          projectId: projectId || 'all',
          model: model || 'all',
          windowStart: new Date(Date.now() - windowHours * 60 * 60 * 1000),
          windowEnd: new Date(),
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalTokens: 0,
          totalRequests: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        }
      }

      const row = result.rows[0]
      return {
        accountId: row.account_id,
        projectId: row.project_id || 'all',
        model: row.model || 'all',
        windowStart: row.window_start,
        windowEnd: row.window_end,
        totalInputTokens: parseInt(row.total_input_tokens),
        totalOutputTokens: parseInt(row.total_output_tokens),
        totalTokens: parseInt(row.total_tokens),
        totalRequests: parseInt(row.total_requests),
        cacheCreationInputTokens: parseInt(row.cache_creation_input_tokens),
        cacheReadInputTokens: parseInt(row.cache_read_input_tokens),
      }
    } catch (error) {
      logger.error('Failed to get usage window', {
        metadata: {
          accountId,
          windowHours,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      throw error
    }
  }

  /**
   * Get sliding window usage with rate limit status
   * Provides 10-minute bucket aggregation over specified days with 5-hour sliding windows
   */
  async getSlidingWindowUsage(
    accountId: string,
    days: number = 7,
    bucketMinutes: number = 10,
    windowHours: number = 5
  ): Promise<{
    accountId: string
    params: {
      days: number
      bucketMinutes: number
      windowHours: number
    }
    data: Array<{
      time_bucket: Date
      sliding_window_tokens: number
      rate_limit_warning_in_window: boolean
    }>
  }> {
    try {
      const query = `
        -- Define the time range and intervals
        WITH params AS (
          SELECT
            NOW() - ($2 * INTERVAL '1 day') AS start_time,
            NOW() AS end_time,
            ($3 * INTERVAL '1 minute') AS bucket_interval,
            ($4 * INTERVAL '1 hour') AS window_interval,
            $1::varchar AS account_id
        ),
        -- Step 1: Aggregate raw requests into buckets
        bucketed_requests AS (
          SELECT
            -- Truncate the timestamp to the floor of the bucket
            date_trunc('hour', ar.timestamp) + floor(extract(minute FROM ar.timestamp) / $3) * ($3 * INTERVAL '1 minute') AS time_bucket,
            SUM(ar.output_tokens) AS tokens_in_bucket,
            -- Check if any request in the bucket had a rate limit warning
            bool_or(
              COALESCE(ar.response_headers->>'anthropic-ratelimit-unified-status', '') = 'allowed_warning'
            ) AS has_warning
          FROM api_requests ar, params p
          WHERE
            ar.account_id = p.account_id
            AND ar.timestamp >= p.start_time
            AND ar.timestamp <= p.end_time
            AND ar.response_headers IS NOT NULL
          GROUP BY 1
        ),
        -- Step 2: Generate a complete time series for the period
        time_series AS (
          SELECT generate_series(
            date_trunc('hour', p.start_time) + floor(extract(minute FROM p.start_time) / $3) * ($3 * INTERVAL '1 minute'),
            p.end_time,
            p.bucket_interval
          ) AS time_bucket
          FROM params p
        )
        -- Step 3: Join the time series with bucketed data and calculate the sliding window
        SELECT
          ts.time_bucket,
          -- Calculate the sum of tokens over the preceding window for each bucket
          COALESCE(
            SUM(COALESCE(br.tokens_in_bucket, 0)) OVER (
              ORDER BY ts.time_bucket
              RANGE BETWEEN (($4 * 60 - 1) * INTERVAL '1 minute') PRECEDING AND CURRENT ROW
            ),
            0
          ) AS sliding_window_tokens,
          -- Carry forward the warning flag within the same sliding window
          COALESCE(
            bool_or(COALESCE(br.has_warning, false)) OVER (
              ORDER BY ts.time_bucket
              RANGE BETWEEN (($4 * 60 - 1) * INTERVAL '1 minute') PRECEDING AND CURRENT ROW
            ),
            false
          ) AS rate_limit_warning_in_window
        FROM time_series ts
        LEFT JOIN bucketed_requests br ON ts.time_bucket = br.time_bucket
        ORDER BY ts.time_bucket
      `

      const result = await this.pool.query(query, [accountId, days, bucketMinutes, windowHours])

      return {
        accountId,
        params: {
          days,
          bucketMinutes,
          windowHours,
        },
        data: result.rows.map(row => ({
          time_bucket: row.time_bucket,
          sliding_window_tokens: parseInt(row.sliding_window_tokens),
          rate_limit_warning_in_window: row.rate_limit_warning_in_window,
        })),
      }
    } catch (error) {
      logger.error('Failed to get sliding window usage', {
        metadata: {
          accountId,
          days,
          bucketMinutes,
          windowHours,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      throw error
    }
  }

  /**
   * Get daily usage statistics
   */
  async getDailyUsage(
    accountId: string,
    days: number = 30,
    projectId?: string
  ): Promise<DailyUsage[]> {
    try {
      let query = `
        SELECT 
          DATE(timestamp AT TIME ZONE 'UTC') as date,
          account_id,
          project_id,
          model,
          SUM(input_tokens) as total_input_tokens,
          SUM(output_tokens) as total_output_tokens,
          SUM(input_tokens + output_tokens) as total_tokens,
          COUNT(*) as total_requests
        FROM api_requests
        WHERE account_id = $1
          AND timestamp >= NOW() - ($2 * INTERVAL '1 day')
      `

      const values: any[] = [accountId, days]

      if (projectId) {
        query += ` AND project_id = $3`
        values.push(projectId)
      }

      query += `
        GROUP BY date, account_id, project_id, model
        ORDER BY date DESC, project_id, model
      `

      const result = await this.pool.query(query, values)

      return result.rows.map(row => ({
        date: row.date.toISOString().split('T')[0],
        accountId: row.account_id,
        projectId: row.project_id,
        model: row.model,
        totalInputTokens: parseInt(row.total_input_tokens),
        totalOutputTokens: parseInt(row.total_output_tokens),
        totalTokens: parseInt(row.total_tokens),
        totalRequests: parseInt(row.total_requests),
      }))
    } catch (error) {
      logger.error('Failed to get daily usage', {
        metadata: {
          accountId,
          days,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      throw error
    }
  }

  /**
   * Get aggregated daily usage (across all models)
   */
  async getAggregatedDailyUsage(
    accountId: string,
    days: number = 30,
    projectId?: string
  ): Promise<DailyUsage[]> {
    try {
      let query = `
        SELECT 
          DATE(timestamp AT TIME ZONE 'UTC') as date,
          account_id,
          projectId,
          SUM(input_tokens) as total_input_tokens,
          SUM(output_tokens) as total_output_tokens,
          SUM(input_tokens + output_tokens) as total_tokens,
          COUNT(*) as total_requests
        FROM api_requests
        WHERE account_id = $1
          AND timestamp >= NOW() - ($2 * INTERVAL '1 day')
      `

      const values: any[] = [accountId, days]

      if (projectId) {
        query += ` AND project_id = $3`
        values.push(projectId)
      }

      query += `
        GROUP BY date, account_id, project_id
        ORDER BY date DESC, project_id
      `

      const result = await this.pool.query(query, values)

      return result.rows.map(row => ({
        date: row.date.toISOString().split('T')[0],
        accountId: row.account_id,
        projectId: row.project_id,
        totalInputTokens: parseInt(row.total_input_tokens),
        totalOutputTokens: parseInt(row.total_output_tokens),
        totalTokens: parseInt(row.total_tokens),
        totalRequests: parseInt(row.total_requests),
      }))
    } catch (error) {
      logger.error('Failed to get aggregated daily usage', {
        metadata: {
          accountId,
          days,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      throw error
    }
  }

  /**
   * Initialize and ensure partitions exist
   * Note: No longer needed as we use api_requests table
   */
  async ensurePartitions(): Promise<void> {
    // No longer needed - using api_requests table
  }
}
