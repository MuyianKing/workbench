import { describe, expect, it, vi } from 'vitest'
import { delay } from './delay'

describe('delay', () => {
  it('到点才 resolve', async () => {
    vi.useFakeTimers()
    let done = false
    const waiting = delay(10).then(() => {
      done = true
    })
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(10)
    await waiting
    expect(done).toBe(true)
    vi.useRealTimers()
  })
})
