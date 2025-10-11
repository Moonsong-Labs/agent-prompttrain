import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import { ProxyApiClient } from '../services/api-client.js'
import { getErrorMessage } from '@agent-prompttrain/shared'
import { layout } from '../layout/index.js'

export const tokenUsageRoutes = new Hono<{
  Variables: {
    apiClient?: ProxyApiClient
  }
}>()

// Helper functions
function formatNumber(num: number): string {
  return num.toLocaleString()
}

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * Token usage dashboard
 */
tokenUsageRoutes.get('/token-usage', async c => {
  const apiClient = c.get('apiClient')
  const accountId = c.req.query('accountId')
  const _projectId = c.req.query('projectId') // Not currently used but kept for future use

  if (!apiClient) {
    return c.html(
      layout(
        'Error',
        html`
          <div class="error-banner">
            <strong>Error:</strong> API client not configured. Please check your configuration.
          </div>
        `
      )
    )
  }

  if (!accountId) {
    // Show all accounts overview
    try {
      const accountsData = await apiClient.getAccountsTokenUsage()

      // Fetch sliding window data for all accounts in parallel
      const slidingWindowPromises = accountsData.accounts.map(
        account =>
          apiClient
            .getSlidingWindowUsage({
              accountId: account.accountId,
              days: 7,
              bucketMinutes: 60, // Use 60-minute buckets for overview to reduce data
              windowHours: 5,
            })
            .catch(() => null) // Handle errors gracefully
      )

      const slidingWindowResults = await Promise.all(slidingWindowPromises)

      // Create a map of accountId to sliding window data
      const slidingWindowMap = new Map()
      slidingWindowResults.forEach((result, index) => {
        if (result) {
          slidingWindowMap.set(accountsData.accounts[index].accountId, result)
        }
      })

      const content = html`
        <div class="mb-6">
          <a href="/dashboard" class="text-blue-600">← Back to Dashboard</a>
        </div>

        <h2 style="margin: 0 0 1.5rem 0;">Token Usage Overview - All Accounts</h2>

        <div class="section">
          <div class="section-header">Active Accounts (7-Day View with 5-Hour Sliding Windows)</div>
          <div class="section-content">
            ${accountsData.accounts.length > 0
              ? html`
                  <div style="display: flex; flex-direction: column; gap: 10px;">
                    ${raw(
                      accountsData.accounts
                        .map(account => {
                          const chartId = `chart-${account.accountId.replace(/[^a-zA-Z0-9]/g, '-')}`
                          const slidingWindowData = slidingWindowMap.get(account.accountId)

                          const chartScript = slidingWindowData
                            ? `
                    (function() {
                      // 7-day sliding window chart for ${account.accountId}
                      const canvas = document.getElementById('${chartId}');
                      if (!canvas) return;
                      
                      const ctx = canvas.getContext('2d');
                      const rect = canvas.getBoundingClientRect();
                      canvas.width = rect.width * window.devicePixelRatio;
                      canvas.height = rect.height * window.devicePixelRatio;
                      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
                      
                      const slidingData = ${JSON.stringify(
                        slidingWindowData.data.map((point: any) => ({
                          tokens: point.sliding_window_tokens,
                          hasWarning: point.rate_limit_warning_in_window,
                        }))
                      )};
                      const tokenLimit = 600000; // Maximum chart height for better visualization
                      
                      // Draw background
                      ctx.fillStyle = '#f9fafb';
                      ctx.fillRect(0, 0, rect.width, rect.height);
                      
                      if (slidingData.length === 0) return;
                      
                      // Find max value for scaling
                      const maxTokens = Math.max(...slidingData.map(d => d.tokens), tokenLimit);
                      
                      // Draw the line with segments
                      ctx.lineWidth = 1.5;
                      let lastWarningState = slidingData[0]?.hasWarning || false;
                      let segmentStart = 0;
                      
                      // Function to draw a line segment
                      const drawSegment = (startIdx, endIdx, hasWarning) => {
                        ctx.beginPath();
                        for (let i = startIdx; i <= endIdx; i++) {
                          const x = (i / (slidingData.length - 1)) * rect.width;
                          const y = rect.height - (slidingData[i].tokens / maxTokens) * rect.height;
                          
                          if (i === startIdx) {
                            ctx.moveTo(x, y);
                          } else {
                            ctx.lineTo(x, y);
                          }
                        }
                        ctx.strokeStyle = hasWarning ? '#fb923c' : '#10b981';
                        ctx.stroke();
                      };
                      
                      // Draw segments based on warning state changes
                      for (let i = 1; i < slidingData.length; i++) {
                        if (slidingData[i].hasWarning !== lastWarningState) {
                          drawSegment(segmentStart, i - 1, lastWarningState);
                          segmentStart = i - 1; // Overlap by one point for continuity
                          lastWarningState = slidingData[i].hasWarning;
                        }
                      }
                      // Draw the final segment
                      if (slidingData.length > 0) {
                        drawSegment(segmentStart, slidingData.length - 1, lastWarningState);
                      }
                      
                      // Draw warning dots
                      ctx.fillStyle = '#fb923c';
                      slidingData.forEach((point, index) => {
                        if (point.hasWarning) {
                          const x = (index / (slidingData.length - 1)) * rect.width;
                          const y = rect.height - (point.tokens / maxTokens) * rect.height;
                          ctx.beginPath();
                          ctx.arc(x, y, 2, 0, Math.PI * 2);
                          ctx.fill();
                        }
                      });
                      
                      // Add hover functionality
                      let tooltip = document.getElementById('${chartId}-tooltip');
                      if (!tooltip) {
                        tooltip = document.createElement('div');
                        tooltip.id = '${chartId}-tooltip';
                        tooltip.style.cssText = 'position: absolute; background: rgba(0,0,0,0.9); color: white; padding: 6px 10px; border-radius: 4px; font-size: 11px; pointer-events: none; display: none; z-index: 1000; white-space: nowrap;';
                        document.body.appendChild(tooltip);
                      }
                      
                      const timeData = ${JSON.stringify(
                        slidingWindowData.data.map((point: any) =>
                          new Date(point.time_bucket).toLocaleString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                          })
                        )
                      )};
                      
                      canvas.addEventListener('mousemove', (e) => {
                        const rect = canvas.getBoundingClientRect();
                        const x = e.clientX - rect.left;
                        const y = e.clientY - rect.top;
                        
                        // Find nearest data point
                        const dataIndex = Math.round((x / rect.width) * (slidingData.length - 1));
                        if (dataIndex >= 0 && dataIndex < slidingData.length) {
                          const point = slidingData[dataIndex];
                          const pointX = (dataIndex / (slidingData.length - 1)) * rect.width;
                          const pointY = rect.height - (point.tokens / maxTokens) * rect.height;
                          
                          // Check if mouse is near the line (within 5 pixels vertically)
                          if (Math.abs(y - pointY) < 5) {
                            tooltip.innerHTML = \`
                              <div style="font-weight: bold;">\${timeData[dataIndex]}</div>
                              <div>Tokens: \${point.tokens.toLocaleString()}</div>
                              \${point.hasWarning ? '<div style="color: #fb923c;">⚠️ Rate Limit Warning</div>' : ''}
                            \`;
                            tooltip.style.left = (e.clientX + 10) + 'px';
                            tooltip.style.top = (e.clientY - 35) + 'px';
                            tooltip.style.display = 'block';
                          } else {
                            tooltip.style.display = 'none';
                          }
                        }
                      });
                      
                      canvas.addEventListener('mouseleave', () => {
                        tooltip.style.display = 'none';
                      });
                    })();
                  `
                            : `
                    (function() {
                      // Fallback to mini chart for ${account.accountId}
                      const canvas = document.getElementById('${chartId}');
                      if (!canvas) return;
                      
                      const ctx = canvas.getContext('2d');
                      const rect = canvas.getBoundingClientRect();
                      canvas.width = rect.width * window.devicePixelRatio;
                      canvas.height = rect.height * window.devicePixelRatio;
                      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
                      
                      const data = ${JSON.stringify(account.miniSeries)};
                      const tokenLimit = ${accountsData.tokenLimit};
                      
                      // Draw background
                      ctx.fillStyle = '#f9fafb';
                      ctx.fillRect(0, 0, rect.width, rect.height);
                      
                      // Draw the line
                      ctx.beginPath();
                      ctx.lineWidth = 1.5;
                      
                      data.forEach((point, index) => {
                        const x = (index / (data.length - 1)) * rect.width;
                        const y = rect.height - (point.remaining / tokenLimit) * rect.height;
                        
                        if (index === 0) {
                          ctx.moveTo(x, y);
                        } else {
                          ctx.lineTo(x, y);
                        }
                      });
                      
                      // Color based on usage
                      const percentageUsed = ${account.percentageUsed};
                      let strokeColor = '#10b981'; // Green
                      if (percentageUsed > 90) {
                        strokeColor = '#ef4444'; // Red
                      } else if (percentageUsed > 70) {
                        strokeColor = '#f59e0b'; // Yellow
                      }
                      
                      ctx.strokeStyle = strokeColor;
                      ctx.stroke();
                      
                      // Fill area
                      ctx.lineTo(rect.width, rect.height);
                      ctx.lineTo(0, rect.height);
                      ctx.closePath();
                      ctx.fillStyle = strokeColor + '20'; // Add transparency
                      ctx.fill();
                    })();
                  `

                          return `
                    <div style="height: 120px; border: 1px solid #e5e7eb; border-radius: 0.5rem; padding: 15px; background: white;">
                      <a href="/dashboard/token-usage?accountId=${encodeURIComponent(account.accountId)}" style="text-decoration: none; color: inherit; display: block;">
                        <div style="display: flex; align-items: flex-start; gap: 20px; height: 100%;">
                          <div style="flex: 1; min-width: 0;">
                            <div style="display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px;">
                              <strong style="font-size: 16px; color: #1f2937;">${escapeHtml(account.accountId)}</strong>
                              <span style="font-size: 14px; color: ${
                                slidingWindowData &&
                                slidingWindowData.data.length > 0 &&
                                slidingWindowData.data[slidingWindowData.data.length - 1]
                                  .rate_limit_warning_in_window
                                  ? '#fb923c'
                                  : '#10b981'
                              };">
                                ${formatNumber(account.outputTokens)} / ${formatNumber(accountsData.tokenLimit)} tokens
                                (${account.percentageUsed.toFixed(1)}% used)
                                ${
                                  slidingWindowData &&
                                  slidingWindowData.data.length > 0 &&
                                  slidingWindowData.data[slidingWindowData.data.length - 1]
                                    .rate_limit_warning_in_window
                                    ? '⚠️ Rate Limit Warning'
                                    : ''
                                }
                              </span>
                            </div>
                            <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px;">
                              ${account.trainIds
                                .map(
                                  projectId => `
                                <div style="font-size: 12px; color: #6b7280; background: #f3f4f6; padding: 4px 8px; border-radius: 4px;">
                                  <span style="color: #374151; font-weight: 500;">${escapeHtml(projectId.projectId)}:</span>
                                  ${formatNumber(projectId.outputTokens)} tokens
                                  (${((projectId.outputTokens / account.outputTokens) * 100).toFixed(0)}%)
                                </div>
                              `
                                )
                                .join('')}
                            </div>
                          </div>
                          <div style="width: 300px; height: 80px; flex-shrink: 0;">
                            <canvas id="${chartId}" style="width: 100%; height: 100%;"></canvas>
                          </div>
                        </div>
                      </a>
                    </div>
                    ${raw(`<script>${chartScript}</script>`)}
                  `
                        })
                        .join('')
                    )}
                  </div>
                `
              : html` <p class="text-gray-500">No active accounts found in the last 5 hours.</p> `}
          </div>
        </div>
      `

      return c.html(layout('Token Usage Overview', content, '', c))
    } catch (error) {
      console.error('Failed to fetch accounts data:', getErrorMessage(error))
      return c.html(
        layout(
          'Token Usage',
          html`
            <div class="error-banner">
              <strong>Error:</strong> Failed to load accounts data. Please try again later.
            </div>
            <div class="mb-6">
              <a href="/dashboard" class="text-blue-600">← Back to Dashboard</a>
            </div>
          `,
          '',
          c
        )
      )
    }
  }

  try {
    // Fetch all data in parallel
    const [
      tokenUsageWindow,
      dailyUsageResult,
      rateLimitsResult,
      slidingWindow24hResult,
      slidingWindow7dResult,
    ] = await Promise.allSettled([
      apiClient.getTokenUsageWindow({ accountId, window: 300 }), // 5 hour window
      apiClient.getDailyTokenUsage({ accountId, days: 30, aggregate: true }), // Daily usage
      apiClient.getRateLimitConfigs({ accountId }), // Rate limit configs
      apiClient.getSlidingWindowUsage({ accountId, days: 1, bucketMinutes: 5, windowHours: 5 }), // 24-hour sliding window with 5-minute buckets
      apiClient.getSlidingWindowUsage({ accountId, days: 7, bucketMinutes: 60, windowHours: 5 }), // 7-day sliding window with 60-minute buckets
    ])

    // Handle results
    const tokenUsage = tokenUsageWindow.status === 'fulfilled' ? tokenUsageWindow.value : null
    const dailyUsage = dailyUsageResult.status === 'fulfilled' ? dailyUsageResult.value.usage : []
    const rateLimits = rateLimitsResult.status === 'fulfilled' ? rateLimitsResult.value.configs : []
    const slidingWindow24h =
      slidingWindow24hResult.status === 'fulfilled' ? slidingWindow24hResult.value : null
    const slidingWindow7d =
      slidingWindow7dResult.status === 'fulfilled' ? slidingWindow7dResult.value : null

    // Find the primary rate limit for this account
    const primaryLimit =
      rateLimits.find(limit => limit.accountId === accountId && !limit.model && !limit.projectId) ||
      rateLimits[0]

    const content = html`
      <div class="mb-6">
        <a href="/dashboard" class="text-blue-600">← Back to Dashboard</a>
      </div>

      <h2 style="margin: 0 0 1.5rem 0;">Token Usage for Account: ${escapeHtml(accountId)}</h2>

      <!-- Current 5-Hour Window Usage -->
      <div class="section">
        <div class="section-header">
          5-Hour Sliding Window Usage (Output Tokens Only)
          <span class="text-sm text-gray-500" style="float: right;">
            ${tokenUsage
              ? `Window: ${new Date(tokenUsage.windowStart).toLocaleTimeString()} - ${new Date(tokenUsage.windowEnd).toLocaleTimeString()}`
              : ''}
          </span>
        </div>
        <div class="section-content">
          ${tokenUsage
            ? html`
                <div style="margin-bottom: 1.5rem;">
                  <!-- Progress bar showing output tokens only -->
                  <div
                    style="position: relative; background: #f3f4f6; height: 40px; border-radius: 0.5rem; overflow: hidden;"
                  >
                    <div
                      style="position: absolute; left: 0; top: 0; height: 100%; background: ${primaryLimit &&
                      tokenUsage.totalOutputTokens / primaryLimit.tokenLimit > 0.9
                        ? '#ef4444'
                        : primaryLimit &&
                            tokenUsage.totalOutputTokens / primaryLimit.tokenLimit > 0.7
                          ? '#f59e0b'
                          : '#10b981'}; width: ${primaryLimit
                        ? Math.min(
                            100,
                            (tokenUsage.totalOutputTokens / primaryLimit.tokenLimit) * 100
                          )
                        : 0}%; transition: width 0.3s ease;"
                    ></div>
                    <div
                      style="position: absolute; left: 0; top: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-weight: 600; color: #1f2937;"
                    >
                      ${formatNumber(tokenUsage.totalOutputTokens)} /
                      ${primaryLimit ? formatNumber(primaryLimit.tokenLimit) : '?'} output tokens
                      (${primaryLimit
                        ? Math.round((tokenUsage.totalOutputTokens / primaryLimit.tokenLimit) * 100)
                        : 0}%)
                    </div>
                  </div>
                </div>

                <!-- Detailed token breakdown -->
                <div class="stats-grid">
                  <div class="stat-card">
                    <div class="stat-label">Input Tokens</div>
                    <div class="stat-value">${formatNumber(tokenUsage.totalInputTokens)}</div>
                    <div class="stat-meta">Messages sent</div>
                  </div>
                  <div class="stat-card">
                    <div class="stat-label">Output Tokens</div>
                    <div class="stat-value">${formatNumber(tokenUsage.totalOutputTokens)}</div>
                    <div class="stat-meta">Responses generated</div>
                  </div>
                  <div class="stat-card">
                    <div class="stat-label">Cache Read Tokens</div>
                    <div class="stat-value">${formatNumber(tokenUsage.cacheReadInputTokens)}</div>
                    <div class="stat-meta">From cache</div>
                  </div>
                  <div class="stat-card">
                    <div class="stat-label">Cache Creation Tokens</div>
                    <div class="stat-value">
                      ${formatNumber(tokenUsage.cacheCreationInputTokens)}
                    </div>
                    <div class="stat-meta">Cached for reuse</div>
                  </div>
                </div>

                <div
                  style="margin-top: 1rem; padding: 1rem; background: #f9fafb; border-radius: 0.375rem;"
                >
                  <div class="text-sm text-gray-600">
                    <strong>Total Requests:</strong> ${tokenUsage.totalRequests}<br />
                    <strong>Total All Tokens:</strong> ${formatNumber(tokenUsage.totalTokens)}<br />
                    <strong>Model:</strong> ${tokenUsage.model || 'All models'}<br />
                    <strong>Project ID:</strong> ${tokenUsage.projectId || 'All trainIds'}
                  </div>
                </div>
              `
            : html`
                <p class="text-gray-500">No token usage data available for this time window.</p>
              `}
        </div>
      </div>

      <!-- 24-Hour Sliding Window Chart -->
      <div class="section">
        <div class="section-header">24-Hour Token Usage (5-Hour Sliding Windows)</div>
        <div class="section-content">
          ${slidingWindow24h && slidingWindow24h.data.length > 0
            ? (() => {
                const chartId = 'chart24h'
                const chartScript = `
              // Prepare 24-hour sliding window chart data
              (function() {
                const slidingData = ${JSON.stringify(
                  slidingWindow24h.data.map(point => ({
                    time: new Date(point.time_bucket).toLocaleString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    }),
                    tokens: point.sliding_window_tokens,
                    hasWarning: point.rate_limit_warning_in_window,
                  }))
                )};
                
                const tokenLimit = 600000; // Maximum chart height for better visualization
              
              // Wait for canvas to be ready
              setTimeout(() => {
                const canvas = document.getElementById('${chartId}');
                if (!canvas) return;
                
                const ctx = canvas.getContext('2d');
                const rect = canvas.getBoundingClientRect();
                canvas.width = rect.width * window.devicePixelRatio;
                canvas.height = rect.height * window.devicePixelRatio;
                ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
                
                const padding = { top: 20, right: 20, bottom: 100, left: 80 };
                const chartWidth = rect.width - padding.left - padding.right;
                const chartHeight = rect.height - padding.top - padding.bottom;
                
                // Clear canvas
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, rect.width, rect.height);
                
                // Draw axes
                ctx.strokeStyle = '#e5e7eb';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(padding.left, padding.top);
                ctx.lineTo(padding.left, padding.top + chartHeight);
                ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight);
                ctx.stroke();
                
                // Draw horizontal grid lines and Y-axis labels
                ctx.fillStyle = '#6b7280';
                ctx.font = '12px sans-serif';
                ctx.textAlign = 'right';
                
                const ySteps = 5;
                for (let i = 0; i <= ySteps; i++) {
                  const y = padding.top + (chartHeight * i / ySteps);
                  const value = tokenLimit * (1 - i / ySteps);
                  
                  // Grid line
                  ctx.strokeStyle = '#f3f4f6';
                  ctx.beginPath();
                  ctx.moveTo(padding.left, y);
                  ctx.lineTo(padding.left + chartWidth, y);
                  ctx.stroke();
                  
                  // Label
                  ctx.fillStyle = '#6b7280';
                  ctx.fillText(formatNumber(value), padding.left - 10, y + 4);
                }
                
                // Draw X-axis labels (rotated for 24h view)
                ctx.save();
                ctx.textAlign = 'right';
                ctx.fillStyle = '#6b7280';
                ctx.font = '11px sans-serif';
                
                const labelInterval = Math.ceil(slidingData.length / 12);
                slidingData.forEach((point, index) => {
                  if (index % labelInterval === 0 || index === slidingData.length - 1) {
                    const x = padding.left + (index / (slidingData.length - 1)) * chartWidth;
                    ctx.save();
                    ctx.translate(x, padding.top + chartHeight + 10);
                    ctx.rotate(-Math.PI / 4);
                    ctx.textAlign = 'right';
                    ctx.fillText(point.time, 0, 0);
                    ctx.restore();
                  }
                });
                ctx.restore();
                
                // Draw usage line with color segments based on rate limit status
                ctx.lineWidth = 2;
                let lastWarningState = slidingData[0]?.hasWarning || false;
                let segmentStart = 0;
                
                // Function to draw a line segment
                const drawSegment = (startIdx, endIdx, hasWarning) => {
                  ctx.beginPath();
                  for (let i = startIdx; i <= endIdx; i++) {
                    const x = padding.left + (i / (slidingData.length - 1)) * chartWidth;
                    const y = padding.top + (1 - slidingData[i].tokens / tokenLimit) * chartHeight;
                    
                    if (i === startIdx) {
                      ctx.moveTo(x, y);
                    } else {
                      ctx.lineTo(x, y);
                    }
                  }
                  ctx.strokeStyle = hasWarning ? '#fb923c' : '#10b981';
                  ctx.stroke();
                };
                
                // Draw segments based on warning state changes
                for (let i = 1; i < slidingData.length; i++) {
                  if (slidingData[i].hasWarning !== lastWarningState) {
                    drawSegment(segmentStart, i - 1, lastWarningState);
                    segmentStart = i - 1; // Overlap by one point for continuity
                    lastWarningState = slidingData[i].hasWarning;
                  }
                }
                // Draw the final segment
                drawSegment(segmentStart, slidingData.length - 1, lastWarningState);
                
                // Draw warning indicators as dots
                ctx.fillStyle = '#fb923c';
                slidingData.forEach((point, index) => {
                  if (point.hasWarning) {
                    const x = padding.left + (index / (slidingData.length - 1)) * chartWidth;
                    const y = padding.top + (1 - point.tokens / tokenLimit) * chartHeight;
                    ctx.beginPath();
                    ctx.arc(x, y, 3, 0, Math.PI * 2);
                    ctx.fill();
                  }
                });
                
                // Draw current point
                const lastPoint = slidingData[slidingData.length - 1];
                const lastX = padding.left + chartWidth;
                const lastY = padding.top + (1 - lastPoint.tokens / tokenLimit) * chartHeight;
                const currentHasWarning = lastPoint.hasWarning;
                
                ctx.fillStyle = currentHasWarning ? '#fb923c' : '#10b981';
                ctx.beginPath();
                ctx.arc(lastX, lastY, 5, 0, Math.PI * 2);
                ctx.fill();
                
                // Draw current value label
                ctx.fillStyle = '#1f2937';
                ctx.font = '14px sans-serif';
                ctx.textAlign = 'right';
                ctx.fillText(
                  formatNumber(lastPoint.tokens) + ' tokens',
                  lastX - 10,
                  lastY - 10
                );
                
                // Add axis labels
                ctx.fillStyle = '#374151';
                ctx.font = '14px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('Time (24 Hours)', padding.left + chartWidth / 2, rect.height - 10);
                
                ctx.save();
                ctx.translate(15, padding.top + chartHeight / 2);
                ctx.rotate(-Math.PI / 2);
                ctx.fillText('Output Tokens (5-Hour Window)', 0, 0);
                ctx.restore();
                
                // Add legend
                const legendY = padding.top - 10;
                ctx.font = '12px sans-serif';
                
                // Normal usage
                ctx.fillStyle = '#10b981';
                ctx.fillRect(padding.left + chartWidth - 200, legendY, 12, 12);
                ctx.fillStyle = '#374151';
                ctx.textAlign = 'left';
                ctx.fillText('Normal', padding.left + chartWidth - 185, legendY + 10);
                
                // Rate limit warning
                ctx.fillStyle = '#fb923c';
                ctx.fillRect(padding.left + chartWidth - 120, legendY, 12, 12);
                ctx.fillStyle = '#374151';
                ctx.fillText('Rate Limit Warning', padding.left + chartWidth - 85, legendY + 10);
                
                // Helper function
                function formatNumber(num) {
                  return num.toLocaleString();
                }
                
                // Add hover functionality
                let tooltip = document.getElementById('${chartId}-tooltip');
                if (!tooltip) {
                  tooltip = document.createElement('div');
                  tooltip.id = '${chartId}-tooltip';
                  tooltip.style.cssText = 'position: absolute; background: rgba(0,0,0,0.9); color: white; padding: 8px 12px; border-radius: 4px; font-size: 12px; pointer-events: none; display: none; z-index: 1000; white-space: nowrap;';
                  document.body.appendChild(tooltip);
                }
                
                canvas.addEventListener('mousemove', (e) => {
                  const rect = canvas.getBoundingClientRect();
                  const x = e.clientX - rect.left;
                  const y = e.clientY - rect.top;
                  
                  // Check if mouse is within chart area
                  if (x >= padding.left && x <= padding.left + chartWidth &&
                      y >= padding.top && y <= padding.top + chartHeight) {
                    
                    // Find nearest data point
                    const dataIndex = Math.round(((x - padding.left) / chartWidth) * (slidingData.length - 1));
                    if (dataIndex >= 0 && dataIndex < slidingData.length) {
                      const point = slidingData[dataIndex];
                      const pointX = padding.left + (dataIndex / (slidingData.length - 1)) * chartWidth;
                      const pointY = padding.top + (1 - point.tokens / tokenLimit) * chartHeight;
                      
                      // Check if mouse is near the point (within 10 pixels)
                      const distance = Math.sqrt(Math.pow(x - pointX, 2) + Math.pow(y - pointY, 2));
                      if (distance < 10) {
                        tooltip.innerHTML = \`
                          <div style="font-weight: bold; margin-bottom: 4px;">\${point.time}</div>
                          <div>Tokens: \${formatNumber(point.tokens)}</div>
                          <div>Usage: \${((point.tokens / tokenLimit) * 100).toFixed(1)}%</div>
                          \${point.hasWarning ? '<div style="color: #fb923c;">⚠️ Rate Limit Warning</div>' : ''}
                        \`;
                        tooltip.style.left = (e.clientX + 10) + 'px';
                        tooltip.style.top = (e.clientY - 40) + 'px';
                        tooltip.style.display = 'block';
                      } else {
                        tooltip.style.display = 'none';
                      }
                    }
                  } else {
                    tooltip.style.display = 'none';
                  }
                });
                
                canvas.addEventListener('mouseleave', () => {
                  tooltip.style.display = 'none';
                });
              }, 100);
              })(); // End of IIFE for 24-hour chart
            `

                return html`
                  <div style="width: 100%; height: 400px; position: relative;">
                    <canvas id="${chartId}" style="width: 100%; height: 100%;"></canvas>
                  </div>
                  ${raw(`<script>${chartScript}</script>`)}
                `
              })()
            : html` <p class="text-gray-500">No 24-hour data available.</p> `}
        </div>
      </div>

      <!-- 7-Day Sliding Window Chart -->
      <div class="section">
        <div class="section-header">7-Day Token Usage (5-Hour Sliding Windows)</div>
        <div class="section-content">
          ${slidingWindow7d && slidingWindow7d.data.length > 0
            ? (() => {
                const chartId = 'chart7d'
                const chartScript = `
              // Prepare 7-day sliding window chart data
              (function() {
                const slidingData = ${JSON.stringify(
                  slidingWindow7d.data.map(point => ({
                    time: new Date(point.time_bucket).toLocaleString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                    }),
                    tokens: point.sliding_window_tokens,
                    hasWarning: point.rate_limit_warning_in_window,
                  }))
                )};
                
                const tokenLimit = 600000; // Maximum chart height for better visualization
              
              // Wait for canvas to be ready
              setTimeout(() => {
                const canvas = document.getElementById('${chartId}');
                if (!canvas) return;
                
                const ctx = canvas.getContext('2d');
                const rect = canvas.getBoundingClientRect();
                canvas.width = rect.width * window.devicePixelRatio;
                canvas.height = rect.height * window.devicePixelRatio;
                ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
                
                const padding = { top: 20, right: 20, bottom: 100, left: 80 };
                const chartWidth = rect.width - padding.left - padding.right;
                const chartHeight = rect.height - padding.top - padding.bottom;
                
                // Clear canvas
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, rect.width, rect.height);
                
                // Draw axes
                ctx.strokeStyle = '#e5e7eb';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(padding.left, padding.top);
                ctx.lineTo(padding.left, padding.top + chartHeight);
                ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight);
                ctx.stroke();
                
                // Draw horizontal grid lines and Y-axis labels
                ctx.fillStyle = '#6b7280';
                ctx.font = '12px sans-serif';
                ctx.textAlign = 'right';
                
                const ySteps = 5;
                for (let i = 0; i <= ySteps; i++) {
                  const y = padding.top + (chartHeight * i / ySteps);
                  const value = tokenLimit * (1 - i / ySteps);
                  
                  // Grid line
                  ctx.strokeStyle = '#f3f4f6';
                  ctx.beginPath();
                  ctx.moveTo(padding.left, y);
                  ctx.lineTo(padding.left + chartWidth, y);
                  ctx.stroke();
                  
                  // Label
                  ctx.fillStyle = '#6b7280';
                  ctx.fillText(formatNumber(value), padding.left - 10, y + 4);
                }
                
                // Draw X-axis labels (show every nth label to avoid crowding)
                ctx.save();
                ctx.textAlign = 'right';
                ctx.translate(0, padding.top + chartHeight + 20);
                const labelInterval = Math.ceil(slidingData.length / 15);
                slidingData.forEach((point, index) => {
                  if (index % labelInterval === 0 || index === slidingData.length - 1) {
                    const x = padding.left + (index / (slidingData.length - 1)) * chartWidth;
                    ctx.save();
                    ctx.translate(x, 0);
                    ctx.rotate(-Math.PI / 4);
                    ctx.fillText(point.time, 0, 0);
                    ctx.restore();
                  }
                });
                ctx.restore();
                
                // Determine if we have any warnings
                const hasAnyWarning = slidingData.some(p => p.hasWarning);
                const currentHasWarning = slidingData[slidingData.length - 1]?.hasWarning || false;
                
                // Draw the usage line with segments
                ctx.lineWidth = 2;
                let lastWarningState = slidingData[0]?.hasWarning || false;
                let segmentStart = 0;
                
                // Function to draw a line segment
                const drawSegment = (startIdx, endIdx, hasWarning) => {
                  ctx.beginPath();
                  for (let i = startIdx; i <= endIdx; i++) {
                    const x = padding.left + (i / (slidingData.length - 1)) * chartWidth;
                    const y = padding.top + (1 - slidingData[i].tokens / tokenLimit) * chartHeight;
                    
                    if (i === startIdx) {
                      ctx.moveTo(x, y);
                    } else {
                      ctx.lineTo(x, y);
                    }
                  }
                  ctx.strokeStyle = hasWarning ? '#fb923c' : '#10b981';
                  ctx.stroke();
                };
                
                // Draw segments based on warning state changes
                for (let i = 1; i < slidingData.length; i++) {
                  if (slidingData[i].hasWarning !== lastWarningState) {
                    drawSegment(segmentStart, i - 1, lastWarningState);
                    segmentStart = i - 1; // Overlap by one point for continuity
                    lastWarningState = slidingData[i].hasWarning;
                  }
                }
                // Draw the final segment
                drawSegment(segmentStart, slidingData.length - 1, lastWarningState);
                
                // Draw warning indicators as dots
                ctx.fillStyle = '#fb923c';
                slidingData.forEach((point, index) => {
                  if (point.hasWarning) {
                    const x = padding.left + (index / (slidingData.length - 1)) * chartWidth;
                    const y = padding.top + (1 - point.tokens / tokenLimit) * chartHeight;
                    ctx.beginPath();
                    ctx.arc(x, y, 3, 0, Math.PI * 2);
                    ctx.fill();
                  }
                });
                
                // Draw current point
                const lastPoint = slidingData[slidingData.length - 1];
                const lastX = padding.left + chartWidth;
                const lastY = padding.top + (1 - lastPoint.tokens / tokenLimit) * chartHeight;
                
                ctx.fillStyle = currentHasWarning ? '#fb923c' : '#10b981';
                ctx.beginPath();
                ctx.arc(lastX, lastY, 5, 0, Math.PI * 2);
                ctx.fill();
                
                // Draw current value label
                ctx.fillStyle = '#1f2937';
                ctx.font = '14px sans-serif';
                ctx.textAlign = 'right';
                ctx.fillText(
                  formatNumber(lastPoint.tokens) + ' tokens',
                  lastX - 10,
                  lastY - 10
                );
                
                // Add axis labels
                ctx.fillStyle = '#374151';
                ctx.font = '14px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('Time (7 Days)', padding.left + chartWidth / 2, rect.height - 10);
                
                ctx.save();
                ctx.translate(15, padding.top + chartHeight / 2);
                ctx.rotate(-Math.PI / 2);
                ctx.fillText('Output Tokens (5-Hour Window)', 0, 0);
                ctx.restore();
                
                // Add legend
                const legendY = padding.top - 10;
                ctx.font = '12px sans-serif';
                
                // Normal usage
                ctx.fillStyle = '#10b981';
                ctx.fillRect(padding.left + chartWidth - 200, legendY, 12, 12);
                ctx.fillStyle = '#374151';
                ctx.textAlign = 'left';
                ctx.fillText('Normal', padding.left + chartWidth - 185, legendY + 10);
                
                // Rate limit warning
                ctx.fillStyle = '#fb923c';
                ctx.fillRect(padding.left + chartWidth - 120, legendY, 12, 12);
                ctx.fillStyle = '#374151';
                ctx.fillText('Rate Limit Warning', padding.left + chartWidth - 85, legendY + 10);
                
                // Helper function
                function formatNumber(num) {
                  return num.toLocaleString();
                }
                
                // Add hover functionality
                let tooltip = document.getElementById('${chartId}-tooltip');
                if (!tooltip) {
                  tooltip = document.createElement('div');
                  tooltip.id = '${chartId}-tooltip';
                  tooltip.style.cssText = 'position: absolute; background: rgba(0,0,0,0.9); color: white; padding: 8px 12px; border-radius: 4px; font-size: 12px; pointer-events: none; display: none; z-index: 1000; white-space: nowrap;';
                  document.body.appendChild(tooltip);
                }
                
                canvas.addEventListener('mousemove', (e) => {
                  const rect = canvas.getBoundingClientRect();
                  const x = e.clientX - rect.left;
                  const y = e.clientY - rect.top;
                  
                  // Check if mouse is within chart area
                  if (x >= padding.left && x <= padding.left + chartWidth &&
                      y >= padding.top && y <= padding.top + chartHeight) {
                    
                    // Find nearest data point
                    const dataIndex = Math.round(((x - padding.left) / chartWidth) * (slidingData.length - 1));
                    if (dataIndex >= 0 && dataIndex < slidingData.length) {
                      const point = slidingData[dataIndex];
                      const pointX = padding.left + (dataIndex / (slidingData.length - 1)) * chartWidth;
                      const pointY = padding.top + (1 - point.tokens / tokenLimit) * chartHeight;
                      
                      // Check if mouse is near the point (within 10 pixels)
                      const distance = Math.sqrt(Math.pow(x - pointX, 2) + Math.pow(y - pointY, 2));
                      if (distance < 10) {
                        tooltip.innerHTML = \`
                          <div style="font-weight: bold; margin-bottom: 4px;">\${point.time}</div>
                          <div>Tokens: \${formatNumber(point.tokens)}</div>
                          <div>Usage: \${((point.tokens / tokenLimit) * 100).toFixed(1)}%</div>
                          \${point.hasWarning ? '<div style="color: #fb923c;">⚠️ Rate Limit Warning</div>' : ''}
                        \`;
                        tooltip.style.left = (e.clientX + 10) + 'px';
                        tooltip.style.top = (e.clientY - 40) + 'px';
                        tooltip.style.display = 'block';
                      } else {
                        tooltip.style.display = 'none';
                      }
                    }
                  } else {
                    tooltip.style.display = 'none';
                  }
                });
                
                canvas.addEventListener('mouseleave', () => {
                  tooltip.style.display = 'none';
                });
              }, 100);
              })(); // End of IIFE for 7-day chart
            `

                return html`
                  <div style="width: 100%; height: 500px; position: relative;">
                    <canvas id="${chartId}" style="width: 100%; height: 100%;"></canvas>
                  </div>
                  ${raw(`<script>${chartScript}</script>`)}
                `
              })()
            : html` <p class="text-gray-500">No 7-day data available.</p> `}
        </div>
      </div>

      <!-- Daily Usage Chart -->
      <div class="section">
        <div class="section-header">Daily Token Usage (Last 30 Days)</div>
        <div class="section-content">
          ${dailyUsage.length > 0
            ? html`
                <div style="overflow-x: auto;">
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Input Tokens</th>
                        <th>Output Tokens</th>
                        <th>Total Tokens</th>
                        <th>Requests</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${raw(
                        dailyUsage
                          .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                          .slice(0, 30)
                          .map(
                            day => `
                        <tr>
                          <td class="text-sm">${new Date(day.date).toLocaleDateString()}</td>
                          <td class="text-sm">${formatNumber(day.totalInputTokens)}</td>
                          <td class="text-sm">${formatNumber(day.totalOutputTokens)}</td>
                          <td class="text-sm">${formatNumber(day.totalTokens)}</td>
                          <td class="text-sm">${day.totalRequests}</td>
                        </tr>
                      `
                          )
                          .join('')
                      )}
                    </tbody>
                  </table>
                </div>
              `
            : html` <p class="text-gray-500">No daily usage data available.</p> `}
        </div>
      </div>

      <!-- Rate Limits Configuration -->
      <div class="section">
        <div class="section-header">Rate Limit Configuration</div>
        <div class="section-content">
          ${rateLimits.length > 0
            ? html`
                <table>
                  <thead>
                    <tr>
                      <th>Scope</th>
                      <th>Window</th>
                      <th>Token Limit</th>
                      <th>Request Limit</th>
                      <th>Fallback Model</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${raw(
                      rateLimits
                        .map(
                          limit => `
                    <tr>
                      <td class="text-sm">
                        ${
                          limit.model
                            ? `Model: ${limit.model}`
                            : limit.projectId
                              ? `Project ID: ${limit.projectId}`
                              : 'Account Default'
                        }
                      </td>
                      <td class="text-sm">${limit.windowMinutes} minutes</td>
                      <td class="text-sm">${formatNumber(limit.tokenLimit)}</td>
                      <td class="text-sm">${limit.requestLimit ? formatNumber(limit.requestLimit) : 'N/A'}</td>
                      <td class="text-sm">${limit.fallbackModel || 'None'}</td>
                      <td class="text-sm">
                        <span style="color: ${limit.enabled ? '#10b981' : '#ef4444'};">
                          ${limit.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                      </td>
                    </tr>
                  `
                        )
                        .join('')
                    )}
                  </tbody>
                </table>
              `
            : html` <p class="text-gray-500">No rate limits configured for this account.</p> `}
        </div>
      </div>
    `

    return c.html(layout('Token Usage', content, '', c))
  } catch (error) {
    return c.html(
      layout(
        'Error',
        html`
          <div class="error-banner">
            <strong>Error:</strong> ${getErrorMessage(error) || 'Failed to load token usage data'}
          </div>
          <div class="mb-6">
            <a href="/dashboard" class="text-blue-600">← Back to Dashboard</a>
          </div>
        `,
        '',
        c
      )
    )
  }
})
