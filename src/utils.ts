import * as core from '@actions/core'

export function normalizeVersion(v: string): string {
  if (!v) return ''
  const match = v.match(/(\d+\.\d+.*)$/)
  return match ? match[1] : v.replace(/^v/, '')
}

let globalDryRun = false

export function setGlobalDryRun(dryRun: boolean): void {
  globalDryRun = dryRun
}

export function log(message: string, dryRun: boolean = globalDryRun): void {
  const prefix = dryRun ? '[DRY RUN] ' : ''
  if (message.includes('\n')) {
    // For multiline messages, prefix each line
    const lines = message.split('\n')
    for (const line of lines) {
      core.info(`${prefix}${line}`)
    }
  } else {
    core.info(`${prefix}${message}`)
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
