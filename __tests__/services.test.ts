import { jest } from '@jest/globals'
import https from 'https'
import { EventEmitter } from 'events'
import { IncomingMessage } from 'http'

const mockPullsList = jest.fn()
const mockPullsUpdate = jest.fn()
const mockIssuesCreateComment = jest.fn()

jest.unstable_mockModule('@actions/github', () => ({
  getOctokit: () => ({
    rest: {
      pulls: {
        list: (...args: unknown[]) => mockPullsList(...args),
        update: (...args: unknown[]) => mockPullsUpdate(...args),
        create: jest.fn()
      },
      issues: {
        createComment: (...args: unknown[]) => mockIssuesCreateComment(...args),
        getLabel: jest.fn(),
        createLabel: jest.fn(),
        addLabels: jest.fn()
      }
    }
  })
}))

let GitHubService: typeof import('../src/services.js').GitHubService
let DockerHubService: typeof import('../src/services.js').DockerHubService

beforeAll(async () => {
  const services = await import('../src/services.js')
  GitHubService = services.GitHubService
  DockerHubService = services.DockerHubService
})

describe('GitHubService', () => {
  let service: InstanceType<typeof GitHubService>

  beforeEach(() => {
    jest.clearAllMocks()
    service = new GitHubService('fake-token')
  })

  it('closeOutdatedPullRequests should close PRs with matching prefix but different branch', async () => {
    mockPullsList.mockResolvedValue({
      data: [
        { number: 1, title: 'Old PR', head: { ref: 'bot-update-app-1.0.0' } },
        {
          number: 2,
          title: 'Target PR',
          head: { ref: 'bot-update-app-2.0.0' }
        },
        {
          number: 3,
          title: 'Other app',
          head: { ref: 'bot-update-other-1.0.0' }
        }
      ]
    })

    await service.closeOutdatedPullRequests(
      'owner',
      'repo',
      'bot-update-app-',
      'bot-update-app-2.0.0'
    )

    expect(mockPullsUpdate).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 1,
      state: 'closed'
    })
    expect(mockIssuesCreateComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 1,
      body: expect.stringContaining('bot-update-app-2.0.0')
    })

    expect(mockPullsUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 2
      })
    )
    expect(mockPullsUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 3
      })
    )
  })
})

describe('DockerHubService', () => {
  let service: InstanceType<typeof DockerHubService>
  let httpsGetSpy: ReturnType<typeof jest.spyOn>

  beforeEach(() => {
    service = new DockerHubService()
    httpsGetSpy = jest.spyOn(https, 'get')
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('fetchLatestTag should find higher version even if it is on the second page', async () => {
    httpsGetSpy.mockImplementation(
      (
        url: string | URL,
        options: ((res: IncomingMessage) => void) | undefined,
        callback?: (res: IncomingMessage) => void
      ) => {
        let cb = callback
        if (typeof options === 'function') {
          cb = options
        }

        const urlStr = url.toString()
        let results: unknown[] = []

        if (urlStr.includes('page=1') || !urlStr.includes('page=')) {
          results = [
            { name: '1.36.1', last_updated: '2025-01-01T00:00:00Z' },
            { name: 'latest', last_updated: '2025-01-01T00:00:00Z' }
          ]
        } else if (urlStr.includes('page=2')) {
          results = [{ name: '1.37.0', last_updated: '2024-12-01T00:00:00Z' }]
        } else {
          results = []
        }

        const mockRes = new EventEmitter() as unknown as IncomingMessage
        mockRes.statusCode = 200

        const mockReq = {
          on: jest.fn().mockReturnThis(),
          end: jest.fn(),
          write: jest.fn(),
          abort: jest.fn()
        }

        setTimeout(() => {
          if (cb) cb(mockRes)
          mockRes.emit('data', JSON.stringify({ results }))
          mockRes.emit('end')
        }, 10)

        return mockReq as unknown as RequestInfo | URL
      }
    )

    const result = await service.fetchLatestTag('busybox')
    expect(result.tag_name).toBe('1.37.0')
  })
})
