import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import { ProxyApiClient } from '../services/api-client.js'
import { getErrorMessage } from '@agent-prompttrain/shared'
import { layout } from '../layout/index.js'
import { logger } from '../middleware/logger.js'

// Type definitions
interface TrainIdInfo {
  projectId: string
  requestCount: number
}

interface HourlyDataPoint {
  hour: string
  count: number
}

interface HourlyUsageResponse {
  data: Record<string, HourlyDataPoint[]>
  query: {
    projectId: string | null
    days: number
  }
}

interface TrainIdsResponse {
  trainIds?: TrainIdInfo[]
}

export const requestUsageRoutes = new Hono<{
  Variables: {
    apiClient?: ProxyApiClient
  }
}>()

// Helper functions
function formatNumber(num: number): string {
  return num.toLocaleString()
}

// Generate consistent color from train identifier
function getTrainColor(projectId: string): string {
  // Predefined palette of diverse, aesthetically pleasing colors
  const colorPalette = [
    '#FF6B6B', // Soft red
    '#4ECDC4', // Turquoise
    '#45B7D1', // Sky blue
    '#96CEB4', // Sage green
    '#FECA57', // Golden yellow
    '#DDA0DD', // Plum
    '#98D8C8', // Mint
    '#F7DC6F', // Soft yellow
    '#BB8FCE', // Lavender
    '#85C1E2', // Light blue
    '#F8B500', // Amber
    '#6C5CE7', // Purple
    '#A8E6CF', // Pale green
    '#FFD3B6', // Peach
    '#FF8B94', // Coral
    '#C7CEEA', // Periwinkle
    '#B2DFDB', // Teal
    '#FFAAA5', // Salmon
    '#FF8C94', // Light coral
    '#B4A7D6', // Lilac
  ]

  // Generate hash from train identifier
  let hash = 0
  for (let i = 0; i < projectId.length; i++) {
    const char = projectId.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32-bit integer
  }

  // Select color from palette based on hash
  const colorIndex = Math.abs(hash) % colorPalette.length
  return colorPalette[colorIndex]
}

/**
 * Project usage dashboard page
 */
requestUsageRoutes.get('/usage', async c => {
  const apiClient = c.get('apiClient')
  const selectedTrainId = c.req.query('projectId')

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

  try {
    // Fetch all trainIds for the selector
    const trainIdsResponse = await apiClient.get<TrainIdsResponse>('/api/train-ids')
    const trainIds = trainIdsResponse.trainIds ?? []

    // Use selected projectId or null to include all projects
    const displayTrainId = selectedTrainId || null

    // Fetch hourly usage data
    const usageParams = new URLSearchParams({ days: '7' })
    if (displayTrainId) {
      usageParams.append('projectId', displayTrainId)
    }
    const usageResponse = await apiClient.get<HourlyUsageResponse>(
      `/api/usage/requests/hourly?${usageParams}`
    )
    const usageData = usageResponse.data || {}
    const chartData = displayTrainId ? usageData[displayTrainId] || [] : usageData

    // Fetch hourly token usage data
    const tokenResponse = await apiClient.get<HourlyUsageResponse>(
      `/api/usage/tokens/hourly?${usageParams}`
    )
    const tokenData = tokenResponse.data || {}
    const tokenChartData = displayTrainId ? tokenData[displayTrainId] || [] : tokenData

    const content = html`
      <div class="mb-6">
        <a href="/dashboard" class="text-blue-600">← Back to Dashboard</a>
      </div>

      <h2 style="margin: 0 0 1.5rem 0;">Project Usage - Hourly Statistics</h2>

      <!-- Project Selector -->
      <div class="section">
        <div class="section-header">Select Project ID</div>
        <div class="section-content">
          <select
            id="train-selector"
            name="projectId"
            style="padding: 8px 12px; border: 1px solid #e5e7eb; border-radius: 0.375rem; font-size: 14px;"
            onchange="window.location.href = '/dashboard/usage' + (this.value ? '?projectId=' + encodeURIComponent(this.value) : '')"
          >
            <option value="" ${!selectedTrainId ? 'selected' : ''}>
              All Project IDs (${formatNumber(trainIds.reduce((sum, d) => sum + d.requestCount, 0))}
              requests)
            </option>
            ${trainIds.length > 0
              ? raw(
                  trainIds
                    .map(
                      (d: TrainIdInfo) =>
                        `<option
                          value="${d.projectId}"
                          ${d.projectId === displayTrainId ? 'selected' : ''}
                        >
                          ${d.projectId} (${formatNumber(d.requestCount)} requests)
                        </option>`
                    )
                    .join('')
                )
              : ''}
          </select>
        </div>
      </div>

      <!-- Hourly Usage Chart -->
      <div class="section">
        <div class="section-header">
          Hourly Request Count - Last 7 Days
          ${displayTrainId
            ? html`<span class="text-sm text-gray-500">(${displayTrainId})</span>`
            : html`<span class="text-sm text-gray-500">(All Project IDs)</span>`}
        </div>
        <div class="section-content">
          ${(displayTrainId && Array.isArray(chartData) && chartData.length > 0) ||
          (!displayTrainId && !Array.isArray(chartData) && Object.keys(chartData).length > 0)
            ? html`
                <canvas
                  id="hourlyChart"
                  width="1000"
                  height="400"
                  style="width: 100%; height: 400px;"
                ></canvas>
                ${raw(`
                  <script>
                    // Chart data from API
                    const chartData = ${JSON.stringify(chartData)};
                    const displayTrainId = ${JSON.stringify(displayTrainId)};
                    const trainColors = ${JSON.stringify(
                      trainIds.reduce((acc: Record<string, string>, d: TrainIdInfo) => {
                        acc[d.projectId] = getTrainColor(d.projectId)
                        return acc
                      }, {})
                    )};
                    
                    // Helper to format numbers with commas
                    function formatNumber(num) {
                      return num.toLocaleString();
                    }
                    
                    // Wait for canvas to be ready
                    setTimeout(() => {
                      const canvas = document.getElementById('hourlyChart');
                      if (!canvas) return;
                      
                      const ctx = canvas.getContext('2d');
                      const rect = canvas.getBoundingClientRect();
                      canvas.width = rect.width * window.devicePixelRatio;
                      canvas.height = rect.height * window.devicePixelRatio;
                      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
                      
                      const padding = { top: 30, right: 30, bottom: 80, left: 80 };
                      const chartWidth = rect.width - padding.left - padding.right;
                      const chartHeight = rect.height - padding.top - padding.bottom;
                      
                      // Clear canvas
                      ctx.fillStyle = '#ffffff';
                      ctx.fillRect(0, 0, rect.width, rect.height);
                      
                      // Create complete hourly timeline for 7 days
                      const now = new Date();
                      const startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                      startTime.setMinutes(0, 0, 0);
                      
                      const hourlyTimeline = [];
                      const isSingleTrain = displayTrainId !== null;
                      
                      if (isSingleTrain) {
                        // Single projectId view
                        const dataMap = new Map();
                        chartData.forEach(point => {
                          const hourKey = new Date(point.hour).toISOString();
                          dataMap.set(hourKey, point.count);
                        });
                        
                        for (let i = 0; i < 168; i++) {
                          const time = new Date(startTime.getTime() + i * 60 * 60 * 1000);
                          const hourKey = time.toISOString();
                          hourlyTimeline.push({
                            time: time,
                            count: dataMap.get(hourKey) || 0
                          });
                        }
                      } else {
                        // Multi-projectId stacked view
                        const trainDataMaps = {};
                        const allTrainIds = Object.keys(chartData);
                        
                        // Build data maps for each train ID
                        allTrainIds.forEach(projectId => {
                          trainDataMaps[projectId] = new Map();
                          if (chartData[projectId]) {
                            chartData[projectId].forEach(point => {
                              const hourKey = new Date(point.hour).toISOString();
                              trainDataMaps[projectId].set(hourKey, point.count);
                            });
                          }
                        });
                        
                        // Create timeline with stacked data
                        for (let i = 0; i < 168; i++) {
                          const time = new Date(startTime.getTime() + i * 60 * 60 * 1000);
                          const hourKey = time.toISOString();
                          const dataPoint = { time: time, projects: {} };
                          
                          allTrainIds.forEach(projectId => {
                            dataPoint.projects[projectId] = trainDataMaps[projectId].get(hourKey) || 0;
                          });
                          
                          hourlyTimeline.push(dataPoint);
                        }
                      }
                      
                      // Find max count for scaling
                      let maxCount;
                      if (isSingleTrain) {
                        maxCount = Math.max(...hourlyTimeline.map(d => d.count), 1);
                      } else {
                        // For stacked view, max is the sum of all trainIds at any hour
                        maxCount = Math.max(
                          ...hourlyTimeline.map(d =>
                            Object.values(d.projects).reduce((sum, count) => sum + count, 0)
                          ),
                          1
                        );
                      }
                      const yScale = chartHeight / maxCount;
                      const barWidth = chartWidth / hourlyTimeline.length;
                      
                      // Draw axes
                      ctx.strokeStyle = '#e5e7eb';
                      ctx.lineWidth = 1;
                      ctx.beginPath();
                      ctx.moveTo(padding.left, padding.top);
                      ctx.lineTo(padding.left, padding.top + chartHeight);
                      ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight);
                      ctx.stroke();
                      
                      // Draw Y-axis labels and grid lines
                      ctx.fillStyle = '#6b7280';
                      ctx.font = '12px sans-serif';
                      ctx.textAlign = 'right';
                      
                      const ySteps = 5;
                      for (let i = 0; i <= ySteps; i++) {
                        const y = padding.top + (chartHeight * i / ySteps);
                        const value = Math.round(maxCount * (1 - i / ySteps));
                        
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
                      
                      // Draw bars
                      if (isSingleTrain) {
                        // Single projectId - simple bars
                        hourlyTimeline.forEach((point, index) => {
                          if (point.count > 0) {
                            const x = padding.left + index * barWidth;
                            const barHeight = point.count * yScale;
                            const y = padding.top + chartHeight - barHeight;
                            
                            ctx.fillStyle = displayTrainId ? trainColors[displayTrainId] : '#3b82f6';
                            ctx.fillRect(x, y, barWidth - 1, barHeight);
                          }
                        });
                      } else {
                        // Multi-projectId - stacked bars
                        const allTrainIds = Object.keys(chartData);
                        
                        hourlyTimeline.forEach((point, index) => {
                          const x = padding.left + index * barWidth;
                          let stackHeight = 0;
                          
                          allTrainIds.forEach(projectId => {
                            const count = point.projects[projectId] || 0;
                            if (count > 0) {
                              const segmentHeight = count * yScale;
                              const y = padding.top + chartHeight - stackHeight - segmentHeight;
                              
                              ctx.fillStyle = trainColors[projectId];
                              ctx.fillRect(x, y, barWidth - 1, segmentHeight);
                              
                              stackHeight += segmentHeight;
                            }
                          });
                        });
                      }
                      
                      // Draw X-axis labels (show date labels for each day)
                      ctx.fillStyle = '#6b7280';
                      ctx.font = '12px sans-serif';
                      ctx.textAlign = 'center';
                      
                      const uniqueDays = new Set();
                      hourlyTimeline.forEach((point, index) => {
                        const dateStr = point.time.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                        if (!uniqueDays.has(dateStr) && point.time.getHours() === 12) { // Show label at noon
                          uniqueDays.add(dateStr);
                          const x = padding.left + index * barWidth + barWidth / 2;
                          ctx.fillText(dateStr, x, padding.top + chartHeight + 25);
                        }
                      });
                      
                      // Add title
                      ctx.fillStyle = '#1f2937';
                      ctx.font = 'bold 14px sans-serif';
                      ctx.textAlign = 'left';
                      ctx.fillText('Requests per Hour', padding.left, padding.top - 10);
                      
                      // Add hover interaction with custom tooltip
                      let tooltipDiv = null;
                      
                      canvas.addEventListener('mousemove', (e) => {
                        const rect = canvas.getBoundingClientRect();
                        const x = e.clientX - rect.left - padding.left;
                        const index = Math.floor(x / barWidth);
                        
                        if (index >= 0 && index < hourlyTimeline.length) {
                          const point = hourlyTimeline[index];
                          const startTime = point.time;
                          const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // Add 1 hour
                          
                          // Create or update tooltip
                          if (!tooltipDiv) {
                            tooltipDiv = document.createElement('div');
                            tooltipDiv.style.position = 'absolute';
                            tooltipDiv.style.backgroundColor = 'rgba(0, 0, 0, 0.9)';
                            tooltipDiv.style.color = 'white';
                            tooltipDiv.style.padding = '8px 12px';
                            tooltipDiv.style.borderRadius = '6px';
                            tooltipDiv.style.fontSize = '12px';
                            tooltipDiv.style.pointerEvents = 'none';
                            tooltipDiv.style.zIndex = '1000';
                            tooltipDiv.style.fontFamily = 'sans-serif';
                            tooltipDiv.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
                            document.body.appendChild(tooltipDiv);
                          }
                          
                          let tooltipHTML = '<div style="font-weight: 600; margin-bottom: 4px;">';
                          tooltipHTML += startTime.toLocaleString('en-US', { 
                            month: 'short', 
                            day: 'numeric', 
                            hour: 'numeric',
                            minute: '2-digit'
                          });
                          tooltipHTML += ' - ';
                          tooltipHTML += endTime.toLocaleString('en-US', { 
                            hour: 'numeric',
                            minute: '2-digit'
                          });
                          tooltipHTML += '</div>';
                          
                          if (isSingleTrain) {
                            tooltipHTML += '<div style="color: #10b981;">Requests: ' + formatNumber(point.count) + '</div>';
                          } else {
                            const total = Object.values(point.projects).reduce((sum, count) => sum + count, 0);
                            tooltipHTML += '<div style="color: #10b981; margin-bottom: 4px;">Total: ' + formatNumber(total) + ' requests</div>';
                            
                            if (total > 0) {
                              tooltipHTML += '<div style="border-top: 1px solid rgba(255,255,255,0.2); margin-top: 4px; padding-top: 4px;">';
                              Object.entries(point.projects).forEach(([projectId, count]) => {
                                if (count > 0) {
                                  const color = trainColors[projectId];
                                  tooltipHTML += '<div style="display: flex; align-items: center; margin: 2px 0;">';
                                  tooltipHTML += '<div style="width: 10px; height: 10px; background: ' + color + '; margin-right: 6px; border-radius: 2px;"></div>';
                                  tooltipHTML += '<div style="flex: 1;">' + projectId + '</div>';
                                  tooltipHTML += '<div style="margin-left: 8px;">' + formatNumber(count) + '</div>';
                                  tooltipHTML += '</div>';
                                }
                              });
                              tooltipHTML += '</div>';
                            }
                          }
                          
                          tooltipDiv.innerHTML = tooltipHTML;
                          tooltipDiv.style.display = 'block';
                          
                          // Position tooltip
                          const tooltipX = e.pageX + 10;
                          const tooltipY = e.pageY - 10;
                          tooltipDiv.style.left = tooltipX + 'px';
                          tooltipDiv.style.top = tooltipY + 'px';
                          
                          // Adjust if tooltip goes off screen
                          const tooltipRect = tooltipDiv.getBoundingClientRect();
                          if (tooltipRect.right > window.innerWidth) {
                            tooltipDiv.style.left = (e.pageX - tooltipRect.width - 10) + 'px';
                          }
                          if (tooltipRect.bottom > window.innerHeight) {
                            tooltipDiv.style.top = (e.pageY - tooltipRect.height - 10) + 'px';
                          }
                        }
                      });
                      
                      canvas.addEventListener('mouseleave', () => {
                        if (tooltipDiv) {
                          tooltipDiv.style.display = 'none';
                        }
                      });
                    }, 100);
                  </script>
                `)}

                <!-- Legend for multi-projectId view -->
                ${!displayTrainId
                  ? html`
                      <div
                        style="margin-top: 20px; padding: 16px; background: #f9fafb; border-radius: 8px;"
                      >
                        <div style="font-weight: 600; margin-bottom: 12px; color: #1f2937;">
                          Project IDs:
                        </div>
                        <div style="display: flex; flex-wrap: wrap; gap: 16px;">
                          ${raw(
                            trainIds
                              .map(
                                (d: TrainIdInfo) => `
                                  <div style="display: flex; align-items: center; gap: 8px;">
                                    <div
                                      style="width: 16px; height: 16px; border-radius: 4px; background: ${getTrainColor(
                                        d.projectId
                                      )};"
                                    ></div>
                                    <span style="font-size: 14px; color: #4b5563;">${d.projectId}</span>
                                  </div>
                                `
                              )
                              .join('')
                          )}
                        </div>
                      </div>
                    `
                  : ''}
              `
            : displayTrainId
              ? html`<p class="text-gray-500">
                  No request data available for the selected projectId in the last 7 days.
                </p>`
              : html`<p class="text-gray-500">
                  No request data available for any projectId in the last 7 days.
                </p>`}
        </div>
      </div>

      <!-- Summary Statistics -->
      ${(displayTrainId && Array.isArray(chartData) && chartData.length > 0) ||
      (!displayTrainId && !Array.isArray(chartData) && Object.keys(chartData).length > 0)
        ? (() => {
            let totalRequests = 0
            let avgPerHour = 0
            let peakHour = { hour: '', count: 0 }
            let activeHours = 0

            if (displayTrainId && Array.isArray(chartData)) {
              // Single projectId stats
              totalRequests = chartData.reduce(
                (sum: number, point: HourlyDataPoint) => sum + point.count,
                0
              )
              avgPerHour = totalRequests / 168
              peakHour = chartData.reduce(
                (max: HourlyDataPoint, point: HourlyDataPoint) =>
                  point.count > max.count ? point : max,
                chartData[0] || { hour: '', count: 0 }
              )
              activeHours = chartData.length
            } else {
              // Multi-projectId stats
              const hourlyTotals = new Map<string, number>()

              Object.values(chartData).forEach((trainData: HourlyDataPoint[]) => {
                trainData.forEach(point => {
                  const current = hourlyTotals.get(point.hour) || 0
                  hourlyTotals.set(point.hour, current + point.count)
                  totalRequests += point.count
                })
              })

              avgPerHour = totalRequests / 168
              activeHours = hourlyTotals.size

              // Find peak hour
              hourlyTotals.forEach((count, hour) => {
                if (count > peakHour.count) {
                  peakHour = { hour, count }
                }
              })
            }

            return html`
              <div class="section">
                <div class="section-header">Summary Statistics</div>
                <div class="section-content">
                  <div class="stats-grid">
                    <div class="stat-card">
                      <div class="stat-label">Total Requests</div>
                      <div class="stat-value">${formatNumber(totalRequests)}</div>
                      <div class="stat-meta">Last 7 days</div>
                    </div>
                    <div class="stat-card">
                      <div class="stat-label">Average per Hour</div>
                      <div class="stat-value">${avgPerHour.toFixed(1)}</div>
                      <div class="stat-meta">Across all hours</div>
                    </div>
                    <div class="stat-card">
                      <div class="stat-label">Peak Hour</div>
                      <div class="stat-value">${formatNumber(peakHour.count)}</div>
                      <div class="stat-meta">${new Date(peakHour.hour).toLocaleString()}</div>
                    </div>
                    <div class="stat-card">
                      <div class="stat-label">Active Hours</div>
                      <div class="stat-value">${activeHours}</div>
                      <div class="stat-meta">Hours with requests</div>
                    </div>
                  </div>
                </div>
              </div>
            `
          })()
        : ''}

      <!-- Hourly Token Usage Chart -->
      <div class="section">
        <div class="section-header">
          Hourly Output Token Usage - Last 7 Days
          ${displayTrainId
            ? html`<span class="text-sm text-gray-500">(${displayTrainId})</span>`
            : html`<span class="text-sm text-gray-500">(All Project IDs)</span>`}
        </div>
        <div class="section-content">
          ${(displayTrainId && Array.isArray(tokenChartData) && tokenChartData.length > 0) ||
          (!displayTrainId &&
            !Array.isArray(tokenChartData) &&
            Object.keys(tokenChartData).length > 0)
            ? html`
                <canvas
                  id="tokenChart"
                  width="1000"
                  height="400"
                  style="width: 100%; height: 400px;"
                ></canvas>
                ${raw(`
                  <script>
                    // Token chart data from API
                    const tokenChartData = ${JSON.stringify(tokenChartData)};
                    const tokenDisplayTrainId = ${JSON.stringify(displayTrainId)};
                    const tokenTrainColors = ${JSON.stringify(
                      trainIds.reduce((acc: Record<string, string>, d: TrainIdInfo) => {
                        acc[d.projectId] = getTrainColor(d.projectId)
                        return acc
                      }, {})
                    )};
                    
                    // Helper to format numbers with commas
                    function formatTokenNumber(num) {
                      return num.toLocaleString();
                    }
                    
                    // Wait for canvas to be ready
                    setTimeout(() => {
                      const canvas = document.getElementById('tokenChart');
                      if (!canvas) return;
                      
                      const ctx = canvas.getContext('2d');
                      const rect = canvas.getBoundingClientRect();
                      canvas.width = rect.width * window.devicePixelRatio;
                      canvas.height = rect.height * window.devicePixelRatio;
                      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
                      
                      const padding = { top: 30, right: 30, bottom: 80, left: 100 };
                      const chartWidth = rect.width - padding.left - padding.right;
                      const chartHeight = rect.height - padding.top - padding.bottom;
                      
                      // Clear canvas
                      ctx.fillStyle = '#ffffff';
                      ctx.fillRect(0, 0, rect.width, rect.height);
                      
                      // Create complete hourly timeline for 7 days
                      const now = new Date();
                      const startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                      startTime.setMinutes(0, 0, 0);
                      
                      const hourlyTimeline = [];
                    const isSingleTrain = tokenDisplayTrainId !== null;
                      
                      if (isSingleTrain) {
                        // Single projectId view
                        const dataMap = new Map();
                        tokenChartData.forEach(point => {
                          const hourKey = new Date(point.hour).toISOString();
                          dataMap.set(hourKey, point.count);
                        });
                        
                        for (let i = 0; i < 168; i++) {
                          const time = new Date(startTime.getTime() + i * 60 * 60 * 1000);
                          const hourKey = time.toISOString();
                          hourlyTimeline.push({
                            time: time,
                            count: dataMap.get(hourKey) || 0
                          });
                        }
                      } else {
                        // Multi-projectId stacked view
                        const trainDataMaps = {};
                        const allTrainIds = Object.keys(tokenChartData);
                        
                        // Build data maps for each train ID
                        allTrainIds.forEach(projectId => {
                          trainDataMaps[projectId] = new Map();
                          if (tokenChartData[projectId]) {
                            tokenChartData[projectId].forEach(point => {
                              const hourKey = new Date(point.hour).toISOString();
                              trainDataMaps[projectId].set(hourKey, point.count);
                            });
                          }
                        });
                        
                        // Create timeline with stacked data
                        for (let i = 0; i < 168; i++) {
                          const time = new Date(startTime.getTime() + i * 60 * 60 * 1000);
                          const hourKey = time.toISOString();
                          const dataPoint = { time: time, projects: {} };
                          
                          allTrainIds.forEach(projectId => {
                            dataPoint.projects[projectId] = trainDataMaps[projectId].get(hourKey) || 0;
                          });
                          
                          hourlyTimeline.push(dataPoint);
                        }
                      }
                      
                      // Find max count for scaling
                      let maxCount;
                      if (isSingleTrain) {
                        maxCount = Math.max(...hourlyTimeline.map(d => d.count), 1);
                      } else {
                        // For stacked view, max is the sum of all trainIds at any hour
                        maxCount = Math.max(
                          ...hourlyTimeline.map(d =>
                            Object.values(d.projects).reduce((sum, count) => sum + count, 0)
                          ),
                          1
                        );
                      }
                      const yScale = chartHeight / maxCount;
                      const barWidth = chartWidth / hourlyTimeline.length;
                      
                      // Draw axes
                      ctx.strokeStyle = '#e5e7eb';
                      ctx.lineWidth = 1;
                      ctx.beginPath();
                      ctx.moveTo(padding.left, padding.top);
                      ctx.lineTo(padding.left, padding.top + chartHeight);
                      ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight);
                      ctx.stroke();
                      
                      // Draw Y-axis labels and grid lines
                      ctx.fillStyle = '#6b7280';
                      ctx.font = '12px sans-serif';
                      ctx.textAlign = 'right';
                      
                      const ySteps = 5;
                      for (let i = 0; i <= ySteps; i++) {
                        const y = padding.top + (chartHeight * i / ySteps);
                        const value = Math.round(maxCount * (1 - i / ySteps));
                        
                        // Grid line
                        ctx.strokeStyle = '#f3f4f6';
                        ctx.beginPath();
                        ctx.moveTo(padding.left, y);
                        ctx.lineTo(padding.left + chartWidth, y);
                        ctx.stroke();
                        
                        // Label
                        ctx.fillStyle = '#6b7280';
                        ctx.fillText(formatTokenNumber(value), padding.left - 10, y + 4);
                      }
                      
                      // Draw bars
                      if (isSingleTrain) {
                        // Single projectId - simple bars
                        hourlyTimeline.forEach((point, index) => {
                          if (point.count > 0) {
                            const x = padding.left + index * barWidth;
                            const barHeight = point.count * yScale;
                            const y = padding.top + chartHeight - barHeight;
                            
                            ctx.fillStyle = tokenDisplayTrainId ? tokenTrainColors[tokenDisplayTrainId] : '#3b82f6';
                            ctx.fillRect(x, y, barWidth - 1, barHeight);
                          }
                        });
                      } else {
                        // Multi-projectId - stacked bars
                        const allTrainIds = Object.keys(tokenChartData);
                        
                        hourlyTimeline.forEach((point, index) => {
                          const x = padding.left + index * barWidth;
                          let stackHeight = 0;
                          
                          allTrainIds.forEach(projectId => {
                            const count = point.projects[projectId] || 0;
                            if (count > 0) {
                              const segmentHeight = count * yScale;
                              const y = padding.top + chartHeight - stackHeight - segmentHeight;
                              
                              ctx.fillStyle = tokenTrainColors[projectId];
                              ctx.fillRect(x, y, barWidth - 1, segmentHeight);
                              
                              stackHeight += segmentHeight;
                            }
                          });
                        });
                      }
                      
                      // Draw X-axis labels (show date labels for each day)
                      ctx.fillStyle = '#6b7280';
                      ctx.font = '12px sans-serif';
                      ctx.textAlign = 'center';
                      
                      const uniqueDays = new Set();
                      hourlyTimeline.forEach((point, index) => {
                        const dateStr = point.time.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                        if (!uniqueDays.has(dateStr) && point.time.getHours() === 12) { // Show label at noon
                          uniqueDays.add(dateStr);
                          const x = padding.left + index * barWidth + barWidth / 2;
                          ctx.fillText(dateStr, x, padding.top + chartHeight + 25);
                        }
                      });
                      
                      // Add title
                      ctx.fillStyle = '#1f2937';
                      ctx.font = 'bold 14px sans-serif';
                      ctx.textAlign = 'left';
                      ctx.fillText('Output Tokens per Hour', padding.left, padding.top - 10);
                      
                      // Add hover interaction with custom tooltip
                      let tooltipDiv = null;
                      
                      canvas.addEventListener('mousemove', (e) => {
                        const rect = canvas.getBoundingClientRect();
                        const x = e.clientX - rect.left - padding.left;
                        const index = Math.floor(x / barWidth);
                        
                        if (index >= 0 && index < hourlyTimeline.length) {
                          const point = hourlyTimeline[index];
                          const startTime = point.time;
                          const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // Add 1 hour
                          
                          // Create or update tooltip
                          if (!tooltipDiv) {
                            tooltipDiv = document.createElement('div');
                            tooltipDiv.style.position = 'absolute';
                            tooltipDiv.style.backgroundColor = 'rgba(0, 0, 0, 0.9)';
                            tooltipDiv.style.color = 'white';
                            tooltipDiv.style.padding = '8px 12px';
                            tooltipDiv.style.borderRadius = '6px';
                            tooltipDiv.style.fontSize = '12px';
                            tooltipDiv.style.pointerEvents = 'none';
                            tooltipDiv.style.zIndex = '1000';
                            tooltipDiv.style.fontFamily = 'sans-serif';
                            tooltipDiv.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
                            document.body.appendChild(tooltipDiv);
                          }
                          
                          let tooltipHTML = '<div style="font-weight: 600; margin-bottom: 4px;">';
                          tooltipHTML += startTime.toLocaleString('en-US', { 
                            month: 'short', 
                            day: 'numeric', 
                            hour: 'numeric',
                            minute: '2-digit'
                          });
                          tooltipHTML += ' - ';
                          tooltipHTML += endTime.toLocaleString('en-US', { 
                            hour: 'numeric',
                            minute: '2-digit'
                          });
                          tooltipHTML += '</div>';
                          
                          if (isSingleTrain) {
                            tooltipHTML += '<div style="color: #60a5fa;">Output Tokens: ' + formatTokenNumber(point.count) + '</div>';
                          } else {
                            const total = Object.values(point.projects).reduce((sum, count) => sum + count, 0);
                            tooltipHTML += '<div style="color: #60a5fa; margin-bottom: 4px;">Total: ' + formatTokenNumber(total) + ' tokens</div>';
                            
                            if (total > 0) {
                              tooltipHTML += '<div style="border-top: 1px solid rgba(255,255,255,0.2); margin-top: 4px; padding-top: 4px;">';
                              Object.entries(point.projects).forEach(([projectId, count]) => {
                                if (count > 0) {
                                  const color = tokenTrainColors[projectId];
                                  tooltipHTML += '<div style="display: flex; align-items: center; margin: 2px 0;">';
                                  tooltipHTML += '<div style="width: 10px; height: 10px; background: ' + color + '; margin-right: 6px; border-radius: 2px;"></div>';
                                  tooltipHTML += '<div style="flex: 1;">' + projectId + '</div>';
                                  tooltipHTML += '<div style="margin-left: 8px;">' + formatTokenNumber(count) + '</div>';
                                  tooltipHTML += '</div>';
                                }
                              });
                              tooltipHTML += '</div>';
                            }
                          }
                          
                          tooltipDiv.innerHTML = tooltipHTML;
                          tooltipDiv.style.display = 'block';
                          
                          // Position tooltip
                          const tooltipX = e.pageX + 10;
                          const tooltipY = e.pageY - 10;
                          tooltipDiv.style.left = tooltipX + 'px';
                          tooltipDiv.style.top = tooltipY + 'px';
                          
                          // Adjust if tooltip goes off screen
                          const tooltipRect = tooltipDiv.getBoundingClientRect();
                          if (tooltipRect.right > window.innerWidth) {
                            tooltipDiv.style.left = (e.pageX - tooltipRect.width - 10) + 'px';
                          }
                          if (tooltipRect.bottom > window.innerHeight) {
                            tooltipDiv.style.top = (e.pageY - tooltipRect.height - 10) + 'px';
                          }
                        }
                      });
                      
                      canvas.addEventListener('mouseleave', () => {
                        if (tooltipDiv) {
                          tooltipDiv.style.display = 'none';
                        }
                      });
                    }, 100);
                  </script>
                `)}
              `
            : displayTrainId
              ? html`<p class="text-gray-500">
                  No token usage data available for the selected projectId in the last 7 days.
                </p>`
              : html`<p class="text-gray-500">
                  No token usage data available for any projectId in the last 7 days.
                </p>`}
        </div>
      </div>
    `

    return c.html(layout('Project Usage', content))
  } catch (error) {
    logger.error('Failed to load request usage page', { error: getErrorMessage(error) })
    return c.html(
      layout(
        'Error',
        html`
          <div class="error-banner">
            <strong>Error:</strong> Failed to load projectId stats data. Please try again later.
          </div>
          <div class="mt-4">
            <a href="/dashboard" class="text-blue-600">← Back to Dashboard</a>
          </div>
        `
      )
    )
  }
})

/**
 * Partial route for HTMX chart updates
 */
requestUsageRoutes.get('/usage/chart', async c => {
  const apiClient = c.get('apiClient')
  const projectId = c.req.query('projectId')

  if (!apiClient || !projectId) {
    return c.html(html`<div class="error-banner">Invalid request</div>`)
  }

  try {
    // Fetch hourly usage data for the specific train
    const usageParams = new URLSearchParams({ days: '7', projectId })
    const usageResponse = await apiClient.get<HourlyUsageResponse>(
      `/api/usage/requests/hourly?${usageParams}`
    )
    const usageData = usageResponse.data || {}
    const chartData = usageData[projectId] || []

    return c.html(html`
      <div id="chart-container">
        ${chartData.length > 0
          ? html`
              <canvas
                id="hourlyChart"
                width="1000"
                height="400"
                style="width: 100%; height: 400px;"
              ></canvas>
              ${raw(`
                <script>
                  // Same chart rendering logic as above
                  const chartData = ${JSON.stringify(chartData)};
                  const projectId = ${JSON.stringify(projectId)};
                  
                  // ... (same chart drawing code as in the main route)
                </script>
              `)}
            `
          : html`<p class="text-gray-500">
              No request data available for ${projectId} in the last 7 days.
            </p>`}
      </div>
    `)
  } catch (_error) {
    return c.html(html`<div class="error-banner">Failed to load chart data</div>`)
  }
})
