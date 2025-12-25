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
