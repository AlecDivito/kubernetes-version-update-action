import {
  generatePrBody,
  compareVersions,
  isPrerelease,
  applyVersionLag
} from '../src/utils.js'

describe('utils', () => {
  describe('applyVersionLag', () => {
    const releases = [
      { tag_name: 'v1.11.0', html_url: '', published_at: '' },
      { tag_name: 'v1.10.2', html_url: '', published_at: '' },
      { tag_name: 'v1.10.1', html_url: '', published_at: '' },
      { tag_name: 'v1.10.0', html_url: '', published_at: '' },
      { tag_name: 'v1.9.3', html_url: '', published_at: '' },
      { tag_name: 'v1.9.2', html_url: '', published_at: '' }
    ]

    it('should not filter anything if lag is 0', () => {
      const filtered = applyVersionLag(releases, 0)
      expect(filtered).toHaveLength(releases.length)
      expect(filtered[0].tag_name).toBe('v1.11.0')
    })

    it('should lag by 1 minor version', () => {
      const filtered = applyVersionLag(releases, 1, 'minor')
      // Should pick latest from the 1st group (v1.10)
      expect(filtered[0].tag_name).toBe('v1.10.2')
      expect(filtered.every((r) => r.tag_name.startsWith('v1.10.'))).toBe(true)
    })

    it('should lag by 2 minor versions', () => {
      const filtered = applyVersionLag(releases, 2, 'minor')
      // Should pick latest from the 2nd group (v1.9)
      expect(filtered[0].tag_name).toBe('v1.9.3')
      expect(filtered.every((r) => r.tag_name.startsWith('v1.9.'))).toBe(true)
    })

    it('should lag by 1 major version', () => {
      const majorReleases = [
        { tag_name: 'v3.0.0', html_url: '', published_at: '' },
        { tag_name: 'v2.5.0', html_url: '', published_at: '' },
        { tag_name: 'v2.4.0', html_url: '', published_at: '' },
        { tag_name: 'v1.0.0', html_url: '', published_at: '' }
      ]
      const filtered = applyVersionLag(majorReleases, 1, 'major')
      // Lag 1 major version: v3 -> v2
      expect(filtered[0].tag_name).toBe('v2.5.0')
      expect(filtered.every((r) => r.tag_name.startsWith('v2.'))).toBe(true)
    })

    it('should lag by 1 patch version', () => {
      const patchReleases = [
        { tag_name: 'v1.0.3', html_url: '', published_at: '' },
        { tag_name: 'v1.0.2', html_url: '', published_at: '' },
        { tag_name: 'v1.0.1', html_url: '', published_at: '' }
      ]
      // Lag 1 patch version: v1.0.3 -> v1.0.2
      const filtered = applyVersionLag(patchReleases, 1, 'patch')
      expect(filtered[0].tag_name).toBe('v1.0.2')
      // Note: patch lag implies picking a specific patch version, so filtering by "group" (which is the full version)
      // returns ONLY that version.
      expect(filtered).toHaveLength(1)
    })

    it('should return original list if not enough groups exist', () => {
      const filtered = applyVersionLag(releases, 5)
      expect(filtered).toHaveLength(releases.length)
      expect(filtered[0].tag_name).toBe('v1.11.0')
    })
  })

  describe('compareVersions', () => {
    it('should identify the highest semantic version from a list of releases', () => {
      const releases = [
        { tag_name: 'v3.0.24' },
        { tag_name: 'v3.2.3' },
        { tag_name: 'v3.0.21' }
      ]

      const sorted = [...releases].sort((a, b) =>
        compareVersions(b.tag_name, a.tag_name)
      )

      expect(sorted[0].tag_name).toBe('v3.2.3')
      expect(sorted[1].tag_name).toBe('v3.0.24')
      expect(sorted[2].tag_name).toBe('v3.0.21')
    })

    it('should handle versions with different number of parts', () => {
      expect(compareVersions('v1.2.1', 'v1.2')).toBe(1)
      expect(compareVersions('v1.2', 'v1.2.1')).toBe(-1)
    })

    it('should handle non-numeric suffixes according to semver', () => {
      // 1.2.0 is greater than 1.2.0-beta.1
      expect(compareVersions('v1.2.0', 'v1.2.0-beta.1')).toBe(1)
      // beta.2 is greater than beta.1
      expect(compareVersions('v1.2.0-beta.2', 'v1.2.0-beta.1')).toBe(1)
      // alpha is less than beta
      expect(compareVersions('v1.2.0-alpha', 'v1.2.0-beta')).toBe(-1)
    })

    it('should identify prerelease versions', () => {
      expect(isPrerelease('v1.2.0-beta.1')).toBe(true)
      expect(isPrerelease('v1.2.0-alpha.5')).toBe(true)
      expect(isPrerelease('v1.2.0-rc.1')).toBe(true)
      expect(isPrerelease('v0.108.0-b.79')).toBe(true)
      expect(isPrerelease('v1.2.0-anything')).toBe(true)
      expect(isPrerelease('v1.2.0')).toBe(false)
    })
  })

  describe('generatePrBody', () => {
    const displayName = 'my-app'
    const aiAssessment = {
      overallRisk: 'Low',
      overallWorryFree: true,
      releases: [
        {
          tag_name: 'v2.0.0',
          html_url: 'http://example.com/v2',
          published_at: '2024-01-01',
          risk: 'Low',
          worryFree: true,
          summary: 'A very important summary that might be long.'
        },
        {
          tag_name: 'v1.1.0',
          html_url: 'http://example.com/v1.1',
          published_at: '2023-12-01',
          risk: 'None',
          worryFree: true,
          summary: 'Another summary.'
        }
      ]
    }
    const relevantReleases = [
      {
        tag_name: 'v2.0.0',
        html_url: 'http://example.com/v2',
        published_at: '2024-01-01'
      },
      {
        tag_name: 'v1.1.0',
        html_url: 'http://example.com/v1.1',
        published_at: '2023-12-01'
      }
    ]
    const logBuffer = 'Some logs here.'

    it('generates a full PR body when under limit', () => {
      const body = generatePrBody(
        displayName,
        aiAssessment,
        relevantReleases,
        logBuffer,
        1000
      )
      expect(body).toContain('AI Risk Assessment')
      expect(body).toContain('v2.0.0')
      expect(body).toContain('A very important summary')
      expect(body).toContain('v1.1.0')
      expect(body).toContain('Another summary')
      expect(body).toContain('Full Execution Logs')
    })

    it('removes logs if body is too long', () => {
      // Set limit small enough that it has to remove logs
      const fullBody = generatePrBody(
        displayName,
        aiAssessment,
        relevantReleases,
        logBuffer,
        1000
      )
      const smallLimit = fullBody.length - 20
      const body = generatePrBody(
        displayName,
        aiAssessment,
        relevantReleases,
        logBuffer,
        smallLimit
      )

      expect(body).not.toContain('Full Execution Logs')
      expect(body).toContain('v2.0.0')
      expect(body).toContain('A very important summary')
    })

    it('removes summaries if body is still too long after removing logs', () => {
      // Base body with 2 links and headers is ~320-330 chars.
      // Summary 1 is ~47 chars.
      // Summary 2 is ~16 chars.
      // Limit 400: should fit logs? No, logs are "Some logs here."
      // Let's use a limit that fits one summary but not two.
      // 320 (base) + 50 (sum1) = 370.
      // 370 + 20 (sum2) = 390.
      // If we set limit to 380, it should fit one summary.
      const body = generatePrBody(
        displayName,
        aiAssessment,
        relevantReleases,
        logBuffer,
        385
      )

      expect(body).not.toContain('Full Execution Logs')
      expect(body.length).toBeLessThanOrEqual(385)

      // Should still have both links
      expect(body).toContain('v2.0.0')
      expect(body).toContain('v1.1.0')
      // Should have the first summary
      expect(body).toContain('A very important summary')
      // Should NOT have the second summary
      expect(body).not.toContain('Another summary')
    })

    it('truncates as last resort', () => {
      const body = generatePrBody(
        displayName,
        aiAssessment,
        relevantReleases,
        logBuffer,
        50
      )
      expect(body.length).toBeLessThanOrEqual(50)
      expect(body).toContain('...(body truncated)')
    })
  })
})
