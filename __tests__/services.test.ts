import { jest } from '@jest/globals'
import https from 'https'
import { DockerHubService } from '../src/services.js'
import { EventEmitter } from 'events'
import { IncomingMessage } from 'http'

describe('DockerHubService', () => {
  let service: DockerHubService
  let httpsGetSpy: ReturnType<typeof jest.spyOn>

  beforeEach(() => {
    service = new DockerHubService()
    httpsGetSpy = jest.spyOn(https, 'get')
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('fetchLatestTag should find higher version even if it is on the second page', async () => {
    // Setup mock responses
    // We want page 1 to NOT have the target version, but have some other versions.
    // We want page 2 to HAVE the target version (which is semantically higher).

    // Scenario:
    // Page 1 (ordered by last_updated): ['1.36.1', 'latest']
    // Page 2: ['1.37.0'] (older update time, so later in pages, but higher version)

    // We expect fetchLatestTag to find 1.37.0 if we tell it we are currently on 1.35.0 (or even 1.37.0).
    // Currently, the function doesn't take 'currentVersion', so it just fetches page 1.
    // So this test verifies the BUG: it will return 1.36.1 instead of 1.37.0.
    // AFTER we fix it to take currentVersion and page, it should return 1.37.0.

    // Mock implementation of https.get
    httpsGetSpy.mockImplementation(
      (
        url: string | URL,
        options: ((res: IncomingMessage) => void) | undefined,
        callback?: (res: IncomingMessage) => void
      ) => {
        // Handle overload
        let cb = callback
        if (typeof options === 'function') {
          cb = options
        } else if (typeof options === 'object' && !callback) {
          // Check if the second arg is the callback (sometimes signature varies)
          // But here we use (url, options, cb) in source code.
        }

        const urlStr = url.toString()
        let results: unknown[] = []

        // Check for page param
        if (urlStr.includes('page=1') || !urlStr.includes('page=')) {
          results = [
            { name: '1.36.1', last_updated: '2025-01-01T00:00:00Z' },
            { name: 'latest', last_updated: '2025-01-01T00:00:00Z' }
          ]
        } else if (urlStr.includes('page=2')) {
          results = [
            { name: '1.37.0', last_updated: '2024-12-01T00:00:00Z' } // Older date, higher version
          ]
        } else {
          results = []
        }

        // Create a mock IncomingMessage
        const mockRes = new EventEmitter() as unknown as IncomingMessage
        mockRes.statusCode = 200

        const mockReq = {
          on: jest.fn().mockReturnThis(),
          end: jest.fn(),
          write: jest.fn(),
          abort: jest.fn()
        }

        // Simulate response
        setTimeout(() => {
          if (cb) cb(mockRes)
          mockRes.emit('data', JSON.stringify({ results }))
          mockRes.emit('end')
        }, 10)

        return mockReq as unknown as RequestInfo | URL
      }
    )

    // Run the service
    // Note: We need to pass currentVersion to make the fix work later.
    // For now, let's call it with the future signature we want, or just accept the fail.
    // But typescript checks types. The current signature is `fetchLatestTag(repo: string)`.
    // I can't call it with 2 args yet.

    // If I test the current code, it will just return 1.36.1.
    // I want to assert that it returns 1.37.0.

    const result = await service.fetchLatestTag('busybox')

    // This Expectation fails with current code (returns 1.36.1)
    expect(result.tag_name).toBe('1.37.0')
  })
})
