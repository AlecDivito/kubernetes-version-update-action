import { generatePrBody } from '../src/utils.js'

describe('utils', () => {
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
