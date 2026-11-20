import {
  DEFAULT_FIVE_HOUR_THRESHOLD,
  DEFAULT_SEVEN_DAY_THRESHOLD,
  thresholdToPercent,
  type OAuthUsageDisplay,
  type OAuthUsageWindowDisplay,
} from '@agent-prompttrain/shared'
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

/** Compact plain-text duration until an ISO reset timestamp, or null if missing/past. */
export function formatTimeLeftPlain(
  isoTimestamp: string | null | undefined,
  now: number = Date.now()
): string | null {
  if (!isoTimestamp) {
    return null
  }
  const diffMs = new Date(isoTimestamp).getTime() - now
  if (!Number.isFinite(diffMs) || diffMs <= 0) {
    return null
  }

  const totalMins = Math.floor(diffMs / 60_000)
  if (totalMins < 1) {
    return '<1m'
  }

  const days = Math.floor(totalMins / (60 * 24))
  const hours = Math.floor((totalMins % (60 * 24)) / 60)
  const mins = totalMins % 60

  const parts: string[] = []
  if (days > 0) {
    parts.push(`${days}d`)
  }
  if (days > 0 || hours > 0) {
    parts.push(`${hours}h`)
  }
  parts.push(`${mins}m`)
  return parts.join(' ')
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
      const color =
        w.over_threshold || w.utilization > 80
          ? '#ef4444'
          : w.utilization > 50
            ? '#fb923c'
            : '#10b981'
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

function formatWindowThresholdLabel(window: OAuthUsageWindowDisplay, fallbackThreshold?: number) {
  const threshold = window.threshold ?? fallbackThreshold
  return threshold !== undefined ? `${window.name} ≥ ${threshold}%` : window.name
}

function latestFutureResetIso(
  resets: Array<string | null | undefined>,
  now: number
): string | null {
  const futureTimestamps = resets
    .filter((iso): iso is string => Boolean(iso))
    .map(iso => new Date(iso).getTime())
    .filter(ts => Number.isFinite(ts) && ts > now)
  return futureTimestamps.length ? new Date(Math.max(...futureTimestamps)).toISOString() : null
}

/**
 * Render a notice when an account (or a model-scoped window) has reached its
 * configured pool utilization threshold and cannot be used until reset.
 */
export function renderThresholdNotice(
  usage: OAuthUsageDisplay | null | undefined,
  variant: 'regular' | 'compact' = 'regular',
  now: number = Date.now()
): string {
  if (!usage || !usage.available) {
    return ''
  }

  const defaultFiveHourPct = thresholdToPercent(DEFAULT_FIVE_HOUR_THRESHOLD)
  const defaultSevenDayPct = thresholdToPercent(DEFAULT_SEVEN_DAY_THRESHOLD)
  const hasServerThresholdEval = usage.over_threshold !== undefined

  let accountOverThreshold = false
  let accountDetails: string[] = []
  let blockedUntilIso: string | null = null

  if (hasServerThresholdEval) {
    accountOverThreshold = Boolean(usage.over_threshold)
    const blockingWindows = usage.windows.filter(w => w.over_threshold && !w.scoped_model)
    accountDetails =
      blockingWindows.length > 0
        ? blockingWindows.map(w => formatWindowThresholdLabel(w))
        : (usage.over_threshold_windows ?? [])
    blockedUntilIso =
      usage.blocked_until_iso ??
      latestFutureResetIso(
        blockingWindows.map(w => w.resets_at_iso),
        now
      )
  } else {
    const fallbackBlocking = usage.windows.filter(
      w =>
        (w.short_name === '5h' && w.utilization >= defaultFiveHourPct) ||
        (w.short_name === '7d' && w.utilization >= defaultSevenDayPct)
    )
    accountOverThreshold = fallbackBlocking.length > 0
    accountDetails = fallbackBlocking.map(w =>
      formatWindowThresholdLabel(w, w.short_name === '5h' ? defaultFiveHourPct : defaultSevenDayPct)
    )
    blockedUntilIso = latestFutureResetIso(
      fallbackBlocking.map(w => w.resets_at_iso),
      now
    )
  }

  const padding = variant === 'compact' ? '5px 8px' : '8px 12px'
  const fontSize = variant === 'compact' ? '11px' : '13px'
  const marginTop = variant === 'compact' ? '6px' : '12px'

  if (accountOverThreshold) {
    const timeLeft = formatTimeLeftPlain(blockedUntilIso, now)
    const resetPhrase = timeLeft ? `until reset (${timeLeft} left)` : 'until reset'
    const detailPart =
      accountDetails.length > 0 ? ` (${escapeHtml(accountDetails.join(', '))})` : ''

    return `
      <div
        data-testid="threshold-notice"
        role="status"
        style="display: flex; align-items: center; gap: 6px; margin-top: ${marginTop}; padding: ${padding}; background: var(--color-error-bg, #fef2f2); border: 1px solid var(--color-error, #fca5a5); border-radius: 4px; color: var(--color-error-text, #991b1b); font-size: ${fontSize}; line-height: 1.4;"
      >
        <span aria-hidden="true">&#9940;</span>
        <span><strong>Over threshold</strong>${detailPart} &mdash; account can't be used ${escapeHtml(resetPhrase)}</span>
      </div>`
  }

  const scopedBlockedWindows = hasServerThresholdEval
    ? usage.windows.filter(w => w.over_threshold && Boolean(w.scoped_model))
    : usage.windows.filter(
        w =>
          (w.short_name.startsWith('5h ') && w.utilization >= defaultFiveHourPct) ||
          (w.short_name.startsWith('7d ') && w.utilization >= defaultSevenDayPct)
      )

  if (scopedBlockedWindows.length === 0) {
    return ''
  }

  return scopedBlockedWindows
    .map(w => {
      const modelLabel = w.scoped_model || w.short_name.replace(/^(5h|7d)\s+/, '')
      const fallbackThreshold = w.short_name.startsWith('5h ')
        ? defaultFiveHourPct
        : defaultSevenDayPct
      const detail = formatWindowThresholdLabel(w, fallbackThreshold)
      const timeLeft = formatTimeLeftPlain(w.resets_at_iso, now)
      const resetPhrase = timeLeft ? `until reset (${timeLeft} left)` : 'until reset'

      return `
      <div
        data-testid="threshold-notice"
        role="status"
        style="display: flex; align-items: center; gap: 6px; margin-top: ${marginTop}; padding: ${padding}; background: var(--color-warning-bg, #fffbeb); border: 1px solid var(--color-warning, #fcd34d); border-radius: 4px; color: var(--color-warning-text, #92400e); font-size: ${fontSize}; line-height: 1.4;"
      >
        <span aria-hidden="true">&#9888;</span>
        <span><strong>Over threshold for ${escapeHtml(modelLabel)}</strong> (${escapeHtml(detail)}) &mdash; can't be used for this model ${escapeHtml(resetPhrase)}</span>
      </div>`
    })
    .join('')
}
