import { describe, it, expect } from 'bun:test'
import { parseVerifyArgs } from '../verify-conversation-summaries'

describe('parseVerifyArgs', () => {
  it('defaults to 3 principals, 50 per page and a 60 s settle margin', () => {
    expect(parseVerifyArgs([])).toEqual({ principals: 3, pageSize: 50, settleSeconds: 60 })
  })

  it('parses every flag', () => {
    expect(
      parseVerifyArgs(['--principals', '0', '--page-size', '20', '--settle-seconds', '0'])
    ).toEqual({ principals: 0, pageSize: 20, settleSeconds: 0 })
  })

  it('rejects invalid values', () => {
    expect(() => parseVerifyArgs(['--principals', '-1'])).toThrow('--principals')
    expect(() => parseVerifyArgs(['--page-size', '0'])).toThrow('--page-size')
    expect(() => parseVerifyArgs(['--settle-seconds', 'x'])).toThrow('--settle-seconds')
    expect(() => parseVerifyArgs(['--settle-seconds'])).toThrow('--settle-seconds')
    expect(() => parseVerifyArgs(['--execute'])).toThrow('Unknown option')
  })
})
