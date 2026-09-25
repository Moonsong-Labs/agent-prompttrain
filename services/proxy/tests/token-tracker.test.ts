import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { logger } from '../src/middleware/logger'
import { tokenTracker } from '../src/services/tokenTracker'

describe('tokenTracker periodic report', () => {
  let print: ReturnType<typeof spyOn>
  let consoleLog: ReturnType<typeof spyOn>
  let debugEnabled: ReturnType<typeof spyOn> | undefined

  beforeEach(() => {
    print = spyOn(tokenTracker, 'printStats').mockImplementation(() => {})
    consoleLog = spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    tokenTracker.stop()
    debugEnabled?.mockRestore()
    print.mockRestore()
    consoleLog.mockRestore()
  })

  it('stays off unless debug logging is enabled', async () => {
    debugEnabled = spyOn(logger, 'isDebugEnabled').mockReturnValue(false)

    tokenTracker.startReporting(5)
    await Bun.sleep(30)

    expect(print).not.toHaveBeenCalled()
    expect(consoleLog).not.toHaveBeenCalled()
  })

  it('prints the report on its interval when debug logging is enabled', async () => {
    debugEnabled = spyOn(logger, 'isDebugEnabled').mockReturnValue(true)

    tokenTracker.startReporting(5)
    await Bun.sleep(30)

    expect(print).toHaveBeenCalled()
  })
})
