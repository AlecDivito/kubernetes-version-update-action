import fs from 'fs'
import yaml from 'js-yaml'
import { log } from './utils.js'

export function getYamlValue(file: string, path: string): string | null {
  if (!fs.existsSync(file)) {
    throw new Error(`File not found: ${file}`)
  }
  const content = fs.readFileSync(file, 'utf8')
  try {
    const data = yaml.load(content) as unknown
    const value = path.split('.').reduce((o: unknown, k: string): unknown => {
      if (o && typeof o === 'object' && k in o) return o[k as keyof typeof o]
      if (Array.isArray(o) && /^\d+$/.test(k)) return o[parseInt(k)]
      return undefined as unknown
    }, data)
    return value !== undefined ? String(value) : null
  } catch {
    const targetKey = path.split('.').pop()
    const match = content.match(
      new RegExp(`^\\s*${targetKey}:\\s*["']?([^#\\n"']+)`, 'm')
    )
    return match ? match[1].trim() : null
  }
}

export function setYamlValue(
  file: string,
  path: string,
  newValue: string,
  type: 'kubernetes' | 'helm',
  dryRun: boolean
): void {
  const content = fs.readFileSync(file, 'utf8')
  const oldValue = getYamlValue(file, path)

  log(`✍️  Update ${file} -> ${path}: ${oldValue} -> ${newValue}`, dryRun)

  if (dryRun) {
    return
  }

  const targetKey = path.split('.').pop()!
  const searchVal = oldValue || ''
  let replaceVal = newValue

  if (type === 'kubernetes' && oldValue && oldValue.includes(':')) {
    const [repo] = oldValue.split(':')
    replaceVal = `${repo}:${newValue}`
  }

  const escapedOldValue = searchVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(
    `^(\\s*(?:-\\s*)?${targetKey}:\\s*)${escapedOldValue}(.*)$`,
    'm'
  )

  let newContent: string
  if (!regex.test(content)) {
    const fallbackRegex = new RegExp(
      `^(\\s*(?:-\\s*)?${targetKey}:\\s*)([^#\\n]+)(.*)$`,
      'm'
    )
    if (!fallbackRegex.test(content)) {
      throw new Error(`Could not find key "${targetKey}" in ${file}`)
    }
    newContent = content.replace(fallbackRegex, `$1${replaceVal}$3`)
  } else {
    newContent = content.replace(regex, `$1${replaceVal}$3`)
  }

  fs.writeFileSync(file, newContent)
}
