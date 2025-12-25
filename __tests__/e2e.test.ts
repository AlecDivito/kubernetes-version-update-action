import { jest } from '@jest/globals'
import fs from 'fs'

// Mocks
const mockCore = {
  getInput: jest.fn(),
  setFailed: jest.fn(),
  info: jest.fn(),
  debug: jest.fn()
}

const mockExec = {
  exec: jest.fn()
}

const mockGithub = {
  getOctokit: jest.fn().mockReturnValue({
    rest: {
      repos: {
        listReleases: jest.fn()
      },
      pulls: {
        create: jest.fn()
      }
    }
  }),
  context: {
    repo: {
      owner: 'test-owner',
      repo: 'test-repo'
    }
  }
}

const mockOpenAI = jest.fn().mockImplementation(() => ({
  chat: {
    completions: {
      create: jest.fn()
    }
  }
}))

// Setup ESM Mocks
jest.unstable_mockModule('@actions/core', () => mockCore)
jest.unstable_mockModule('@actions/exec', () => mockExec)
jest.unstable_mockModule('@actions/github', () => mockGithub)
jest.unstable_mockModule('openai', () => ({ OpenAI: mockOpenAI }))

// Import run after mocks are set
const { run } = await import('../src/main.js')

describe('End-to-End Version Update Action', () => {
  const testManifestPath = 'test-manifest.yaml'

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.GITHUB_REPOSITORY = 'alecdivito/homelab'

    // Default Inputs
    ;(mockCore.getInput as jest.Mock).mockImplementation((name: unknown) => {
      switch (name) {
        case 'repo':
          return 'owner/repo'
        case 'type':
          return 'kubernetes'
        case 'source':
          return 'github'
        case 'targets':
          return JSON.stringify([
            {
              file: testManifestPath,
              path: 'spec.template.spec.containers.0.image'
            }
          ])
        case 'github_token':
          return 'fake-token'
        case 'dry_run':
          return 'false'
        case 'openai_api_key':
          return 'fake-key'
        case 'openai_model':
          return 'gpt-4'
        case 'openai_base_url':
          return 'https://api.openai.com/v1'
        default:
          return ''
      }
    })

    // Create a dummy manifest
    fs.writeFileSync(
      testManifestPath,
      'spec:\n  template:\n    spec:\n      containers:\n      - image: myrepo/app:1.0.0'
    )
  })

  afterEach(() => {
    if (fs.existsSync(testManifestPath)) {
      fs.unlinkSync(testManifestPath)
    }
  })

  it('successfully updates a version and creates a PR', async () => {
    // Mock GitHub Releases
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const octokit = mockGithub.getOctokit('fake-token') as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(octokit.rest.repos.listReleases as any).mockResolvedValue({
      data: [
        {
          tag_name: 'v1.1.0',
          html_url: 'http://example.com/1.1.0',
          published_at: '2023-01-01T00:00:00Z'
        },
        {
          tag_name: 'v1.0.0',
          html_url: 'http://example.com/1.0.0',
          published_at: '2022-01-01T00:00:00Z'
        }
      ]
    })

    // Mock OpenAI
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const openai = mockOpenAI() as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(openai.chat.completions.create as any).mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Minor bug fixes',
              worryFree: true,
              risk: 'Low',
              recommendations: 'No special steps'
            })
          }
        }
      ]
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (run as any)()

    // Verify File Content
    const updatedContent = fs.readFileSync(testManifestPath, 'utf8')
    expect(updatedContent).toContain('myrepo/app:1.1.0')

    // Verify Git Commands
    expect(mockExec.exec).toHaveBeenCalledWith('git', [
      'checkout',
      '-b',
      expect.stringContaining('bot-update-repo-1.1.0')
    ])
    expect(mockExec.exec).toHaveBeenCalledWith('git', [
      'commit',
      '-m',
      expect.stringContaining('chore: bump repo to 1.1.0')
    ])
    expect(mockExec.exec).toHaveBeenCalledWith('git', [
      'push',
      'origin',
      expect.stringContaining('bot-update-repo-1.1.0')
    ])

    // Verify PR Creation
    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'chore: update repo to 1.1.0',
        body: expect.stringContaining('AI Risk Assessment')
      })
    )
  })

  it('skips update if already at latest version', async () => {
    // Current version in file is 1.0.0, so we mock latest release as 1.0.0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const octokit = mockGithub.getOctokit('fake-token') as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(octokit.rest.repos.listReleases as any).mockResolvedValue({
      data: [
        {
          tag_name: 'v1.0.0',
          html_url: 'http://example.com/1.0.0',
          published_at: '2022-01-01T00:00:00Z'
        }
      ]
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (run as any)()

    // Verify no PR was created
    expect(octokit.rest.pulls.create).not.toHaveBeenCalled()
    // Verify log message
    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('already up to date')
    )
  })

  it('respects dry_run flag', async () => {
    ;(mockCore.getInput as jest.Mock).mockImplementation((name: unknown) => {
      if (name === 'dry_run') return 'true'
      if (name === 'repo') return 'owner/repo'
      if (name === 'type') return 'kubernetes'
      if (name === 'source') return 'github'
      if (name === 'targets')
        return JSON.stringify([
          {
            file: testManifestPath,
            path: 'spec.template.spec.containers.0.image'
          }
        ])
      if (name === 'github_token') return 'fake-token'
      return ''
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const octokit = mockGithub.getOctokit('fake-token') as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(octokit.rest.repos.listReleases as any).mockResolvedValue({
      data: [
        {
          tag_name: 'v1.1.0',
          html_url: 'http://example.com/1.1.0',
          published_at: '2023-01-01T00:00:00Z'
        }
      ]
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (run as any)()

    // File should NOT be updated
    const content = fs.readFileSync(testManifestPath, 'utf8')
    expect(content).toContain('1.0.0')

    // No git commands should be run for commit/push
    expect(mockExec.exec).not.toHaveBeenCalled()
    expect(octokit.rest.pulls.create).not.toHaveBeenCalled()
  })
})
