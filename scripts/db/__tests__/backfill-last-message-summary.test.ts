import { describe, it, expect } from 'bun:test'
import { parseBackfillArgs } from '../backfill-last-message-summary'

describe('parseBackfillArgs', () => {
  it('defaults to a safe dry run over 90 days', () => {
    expect(parseBackfillArgs([])).toEqual({
      days: 90,
      batchSize: 200,
      sleepMs: 250,
      maxBatches: undefined,
      before: undefined,
      execute: false,
    })
  })

  it('parses every flag', () => {
    expect(
      parseBackfillArgs([
        '--days',
        '30',
        '--batch-size',
        '50',
        '--sleep-ms',
        '0',
        '--max-batches',
        '3',
        '--before',
        '2026-09-01T00:00:00.000Z',
        '--execute',
      ])
    ).toEqual({
      days: 30,
      batchSize: 50,
      sleepMs: 0,
      maxBatches: 3,
      before: '2026-09-01T00:00:00.000Z',
      execute: true,
    })
  })

  it('rejects invalid values', () => {
    expect(() => parseBackfillArgs(['--days', '0'])).toThrow('--days')
    expect(() => parseBackfillArgs(['--batch-size', '5000'])).toThrow('--batch-size')
    expect(() => parseBackfillArgs(['--before', 'yesterday'])).toThrow('--before')
    expect(() => parseBackfillArgs(['--bogus'])).toThrow('Unknown option')
  })
})
