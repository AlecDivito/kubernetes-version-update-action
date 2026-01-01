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
    `^(\\s*(?:-\\s*)?${targetKey}:\\s*)(${escapedOldValue})(.*)$`,
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

export function removeApplicationFromConfig(
  configFile: string,
  repo: string,
  dryRun: boolean
): void {
  log(`🗑️  Removing application with repo "${repo}" from ${configFile}`, dryRun)

  if (dryRun) return

  if (!fs.existsSync(configFile)) {
    throw new Error(`Config file not found: ${configFile}`)
  }

  const content = fs.readFileSync(configFile, 'utf8')
  const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const lines = content.split('\n')
  let startIndex = -1
  let endIndex = -1
  let indent = ''

  // 1. Find the line that has the repo
  let repoLineIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (
      lines[i].match(new RegExp(`^\\s*repo:\\s+['"]?${escapedRepo}['"]?\\s*$`))
    ) {
      repoLineIndex = i
      break
    }
  }

  if (repoLineIndex === -1) {
    log(`⚠️  Could not find application with repo "${repo}" in ${configFile}`)
    return
  }

  // 2. Search upwards from repo line to find the start of the list item (starts with -)
  for (let i = repoLineIndex; i >= 0; i--) {
    const match = lines[i].match(/^(\s*)-\s+/)
    if (match) {
      startIndex = i
      indent = match[1]
      break
    }
  }

  if (startIndex === -1) {
    log(
      `⚠️  Could not find start of application block for repo "${repo}" in ${configFile}`
    )
    return
  }

  // 3. Search downwards from startIndex to find the next list item at the same indentation
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (lines[i].match(new RegExp(`^${indent}-\\s+`))) {
      endIndex = i
      break
    }
    // Or if we find a line that is less indented than our app block (and not empty)
    const lineIndentMatch = lines[i].match(/^(\s*)\S/)
    if (lineIndentMatch && lineIndentMatch[1].length < indent.length) {
      endIndex = i
      break
    }
  }

  if (endIndex === -1) endIndex = lines.length

  lines.splice(startIndex, endIndex - startIndex)
  const newContent = lines.join('\n').replace(/\n{3,}/g, '\n\n')
  fs.writeFileSync(configFile, newContent)
}

export function updateConfigVersion(
  configFile: string,
  repo: string,
  newVersion: string,
  dryRun: boolean
): void {
  log(
    `✍️  Updating version for repo "${repo}" in ${configFile} to ${newVersion}`,
    dryRun
  )

  if (dryRun) return

  if (!fs.existsSync(configFile)) {
    throw new Error(`Config file not found: ${configFile}`)
  }

  const content = fs.readFileSync(configFile, 'utf8')
  const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const lines = content.split('\n')
  let appStartIndex = -1
  let nextAppStartIndex = -1
  let indent = ''

  // 1. Find the repo line
  let repoLineIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (
      lines[i].match(new RegExp(`^\\s*repo:\\s+['"]?${escapedRepo}['"]?\\s*$`))
    ) {
      repoLineIndex = i
      break
    }
  }

  if (repoLineIndex === -1) {
    throw new Error(
      `Could not find application with repo "${repo}" in ${configFile}`
    )
  }

  // 2. Find start of block
  for (let i = repoLineIndex; i >= 0; i--) {
    const match = lines[i].match(/^(\s*)-\s+/)
    if (match) {
      appStartIndex = i
      indent = match[1]
      break
    }
  }

  // 3. Find end of block
  for (let i = appStartIndex + 1; i < lines.length; i++) {
    if (lines[i].match(new RegExp(`^${indent}-\\s+`))) {
      nextAppStartIndex = i
      break
    }
    const lineIndentMatch = lines[i].match(/^(\s*)\S/)
    if (lineIndentMatch && lineIndentMatch[1].length < indent.length) {
      nextAppStartIndex = i
      break
    }
  }

  const searchEndIndex =
    nextAppStartIndex !== -1 ? nextAppStartIndex : lines.length
  let versionIndex = -1

  for (let i = appStartIndex; i < searchEndIndex; i++) {
    if (lines[i].match(/^\s*version:/)) {
      versionIndex = i
      break
    }
  }

  if (versionIndex !== -1) {
    lines[versionIndex] = lines[versionIndex].replace(
      /^((\s*)version:\s*)(.*)$/,
      `$1${newVersion}`
    )
  } else {
    // Add version field - find indentation of repo line
    const repoIndent = lines[repoLineIndex].match(/^(\s*)/)![1]
    lines.splice(repoLineIndex + 1, 0, `${repoIndent}version: ${newVersion}`)
  }

  fs.writeFileSync(configFile, lines.join('\n'))
}
