import * as core from '@actions/core'
import { Release } from './types.js'

let globalDryRun = false
const logBuffer: string[] = []

export function setGlobalDryRun(dryRun: boolean): void {
  globalDryRun = dryRun
}

export function getLogBuffer(): string {
  return logBuffer.join('\n')
}

export function normalizeVersion(v: string): string {
  if (!v) return ''
  const match = v.match(/(\d+\.\d+.*)$/)
  return match ? match[1] : v.replace(/^v/, '')
}

export function isPrerelease(v: string): boolean {
  const norm = normalizeVersion(v)
  return /[-](alpha|beta|rc|next|canary|pre)/i.test(norm)
}

export function compareVersions(v1: string, v2: string): number {
  const norm1 = normalizeVersion(v1)
  const norm2 = normalizeVersion(v2)

  const hyphen1 = norm1.indexOf('-')
  const ver1 = hyphen1 === -1 ? norm1 : norm1.substring(0, hyphen1)
  const pre1 = hyphen1 === -1 ? '' : norm1.substring(hyphen1 + 1)

  const hyphen2 = norm2.indexOf('-')
  const ver2 = hyphen2 === -1 ? norm2 : norm2.substring(0, hyphen2)
  const pre2 = hyphen2 === -1 ? '' : norm2.substring(hyphen2 + 1)

  const parts1 = ver1.split('.').map(Number)
  const parts2 = ver2.split('.').map(Number)

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] ?? 0
    const p2 = parts2[i] ?? 0
    if (p1 > p2) return 1
    if (p1 < p2) return -1
  }

  if (!pre1 && pre2) return 1
  if (pre1 && !pre2) return -1
  if (!pre1 && !pre2) return 0

  const preParts1 = pre1.split('.')
  const preParts2 = pre2.split('.')
  for (let i = 0; i < Math.max(preParts1.length, preParts2.length); i++) {
    const p1 = preParts1[i]
    const p2 = preParts2[i]
    if (p1 === undefined) return -1
    if (p2 === undefined) return 1

    const n1 = Number(p1)
    const n2 = Number(p2)
    const isN1 = !isNaN(n1) && p1 !== ''
    const isN2 = !isNaN(n2) && p2 !== ''

    if (isN1 && isN2) {
      if (n1 > n2) return 1
      if (n1 < n2) return -1
    } else if (isN1) {
      return -1
    } else if (isN2) {
      return 1
    } else {
      if (p1 > p2) return 1
      if (p1 < p2) return -1
    }
  }
  return 0
}

export function getRelevantReleases(
  releases: Release[],
  currentVersion: string,
  maxReleases: number
): Release[] {
  const cur = normalizeVersion(currentVersion)
  const relevant: Release[] = []
  for (const r of releases) {
    const tag = normalizeVersion(r.tag_name)
    if (tag === cur) break
    relevant.push(r)
    if (relevant.length >= maxReleases) break
  }
  return relevant
}

export function log(message: string, dryRun: boolean = globalDryRun): void {
  const prefix = dryRun ? '[DRY RUN] ' : ''
  const lines = message.split('\n')
  for (const line of lines) {
    const formatted = `${prefix}${line}`
    core.info(formatted)
    logBuffer.push(formatted)
  }
}

export function formatRisk(risk: string): string {
  switch (risk) {
    case 'None':
      return 'None ✅'
    case 'Low':
      return 'Low 🟢'
    case 'Medium':
      return 'Medium 🟡'
    case 'High':
      return 'High 🔴'
    default:
      return risk
  }
}

export function generatePrBody(
  displayName: string,
  aiAssessment: {
    overallRisk: string
    overallWorryFree: boolean
    releases: {
      tag_name: string
      html_url: string
      published_at: string
      risk: string
      worryFree: boolean
      summary: string
      recommendations?: string
    }[]
  } | null,
  relevantReleases: {
    tag_name: string
    html_url: string
    published_at: string
  }[],
  logBuffer: string,
  maxBodySize: number = 65000
): string {
  let prBody = ''
  let includeLogs = true
  let aiDescriptionsLimit = aiAssessment ? aiAssessment.releases.length : 0

  while (true) {
    prBody = `Automated version update for **${displayName}**.\n\n`

    if (aiAssessment) {
      prBody += `### 🤖 AI Risk Assessment\n`
      prBody += `- **Overall Risk Level**: ${formatRisk(aiAssessment.overallRisk)}\n`
      prBody += `- **Overall Worry Free**: ${aiAssessment.overallWorryFree ? 'Yes ✅' : 'No ⚠️'}\n\n`
      prBody += `#### Detailed Release Summaries\n`
      for (let i = 0; i < aiAssessment.releases.length; i++) {
        const rel = aiAssessment.releases[i]
        const dateStr = rel.published_at
          ? new Date(rel.published_at).toLocaleDateString()
          : 'unknown date'
        prBody += `- **[${rel.tag_name}](${rel.html_url})** (${dateStr}) (Risk: ${formatRisk(rel.risk)}, Worry-free: ${rel.worryFree ? 'Yes' : 'No'})\n`

        if (i < aiDescriptionsLimit) {
          prBody += `  ${rel.summary}\n`
          if (rel.risk !== 'None' && rel.recommendations) {
            prBody += `  > **💡 Recommendation:** ${rel.recommendations}\n`
          }
        }
      }
    } else {
      prBody += `### 📦 Included Releases\n`
      for (const rel of relevantReleases) {
        const dateStr = rel.published_at
          ? new Date(rel.published_at).toLocaleDateString()
          : 'unknown date'
        prBody += `- **[${rel.tag_name}](${rel.html_url})** (${dateStr})\n`
      }
    }

    if (includeLogs) {
      prBody += `\n---\n<details>\n<summary>📄 Full Execution Logs</summary>\n\n\`\`\`text\n${logBuffer}\n\`\`\`\n</details>\n`
    }

    if (prBody.length <= maxBodySize) {
      break
    }

    // Try reducing content
    if (includeLogs) {
      includeLogs = false
    } else if (aiDescriptionsLimit > 0) {
      aiDescriptionsLimit--
    } else {
      // Last resort truncation
      prBody = prBody.substring(0, maxBodySize - 50) + '\n\n...(body truncated)'
      break
    }
  }

  return prBody
}
