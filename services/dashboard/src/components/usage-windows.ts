import type { OAuthUsageDisplay } from '@agent-prompttrain/shared'
import { escapeHtml } from '../utils/formatters.js'

/** Fixed-width monospace segments so the time-left column aligns across rows. */
function formatTimeLeft(isoTimestamp: string): string {
  const diffMs = new Date(isoTimestamp).getTime() - Date.now()
  if (!Number.isFinite(diffMs) || diffMs <= 0) {
    return '<span style="font-family: monospace;">now</span>'
  }

  const totalMins = Math.floor(diffMs / 60_000)
  const days = Math.floor(totalMins / (60 * 24))
  const hours = Math.floor((totalMins % (60 * 24)) / 60)
  const mins = totalMins % 60

  const cell = (value: number, unit: string) =>
    `<span style="display: inline-block; width: 2ch; text-align: right;">${value}</span>${unit}`
  const blank = '<span style="display: inline-block; width: 3ch;"></span>'

  const parts = [
    days > 0 ? cell(days, 'd') : blank,
    days > 0 || hours > 0 ? cell(hours, 'h') : blank,
    cell(mins, 'm'),
  ]
  return `<span style="font-family: monospace; white-space: pre;">${parts.join(' ')}</span>`
}

/** Visual scale of the rows: `compact` for inline cards, `large` for a detail page. */
export type UsageWindowsSize = 'compact' | 'regular' | 'large'

const SIZES: Record<
  UsageWindowsSize,
  { label: number; bar: number; barMax: number; font: number; gap: number; timeLeft: number }
> = {
  compact: { label: 100, bar: 12, barMax: 160, font: 11, gap: 8, timeLeft: 80 },
  regular: { label: 100, bar: 20, barMax: 200, font: 13, gap: 12, timeLeft: 90 },
  large: { label: 140, bar: 24, barMax: 300, font: 14, gap: 16, timeLeft: 110 },
}

/**
 * Render an account's OAuth usage windows as one labelled bar per window
 * (5-hour, 7-day, and any model-scoped weekly), each with its utilization and
 * time to reset.
 */
export function renderUsageWindows(
  usage: OAuthUsageDisplay,
  size: UsageWindowsSize = 'regular'
): string {
  const s = SIZES[size]
  const rows = usage.windows
    .map(w => {
      const color = w.utilization > 80 ? '#ef4444' : w.utilization > 50 ? '#fb923c' : '#10b981'
      return `
      <div style="display: flex; align-items: center; gap: ${s.gap}px;">
        <div style="min-width: ${s.label}px; font-size: ${s.font}px; font-weight: 500; color: #374151;">
          ${escapeHtml(w.name)}
        </div>
        <div style="flex: 1; max-width: ${s.barMax}px;">
          <div style="position: relative; background: #f3f4f6; height: ${s.bar}px; border-radius: 4px; overflow: hidden;">
            <div style="position: absolute; left: 0; top: 0; height: 100%; background: ${color}; width: ${Math.min(100, w.utilization)}%;"></div>
            <div style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: ${s.font - 2}px; color: #1f2937;">
              ${w.utilization.toFixed(1)}%
            </div>
          </div>
        </div>
        <div style="min-width: ${s.timeLeft}px; font-size: ${s.font - 1}px; color: #6b7280;">
          <strong style="color: #374151;">${formatTimeLeft(w.resets_at_iso)}</strong> left
        </div>
      </div>`
    })
    .join('')
  return `<div style="display: grid; gap: ${s.gap}px;">${rows}</div>`
}
