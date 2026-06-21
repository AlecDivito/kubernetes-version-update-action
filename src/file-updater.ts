import fs from 'fs'
import yaml from 'js-yaml'
import { log } from './utils.js'

function getLineIndent(line: string): number {
  const match = line.match(/^(\s*)/)
  return match ? match[1].length : 0
}

export function findLineIndexForYamlPath(
  content: string,
  path: string
): number {
  const segments = path.split('.')
  const lines = content.split('\n')

  function findSegment(
    startLine: number,
    segIndex: number,
    parentIndent: number
  ): number {
    if (segIndex >= segments.length) return -1

    const segment = segments[segIndex]

    if (/^\d+$/.test(segment)) {
      const targetIndex = parseInt(segment, 10)
      let listIndex = 0

      for (let i = startLine; i < lines.length; i++) {
        const line = lines[i]
        if (!line.trim()) continue

        const indent = getLineIndent(line)
        if (indent <= parentIndent && listIndex > 0) break

        if (!line.match(/^\s*-\s+/)) continue

        if (listIndex === targetIndex) {
          if (segIndex + 1 >= segments.length) return i

          const nextSegment = segments[segIndex + 1]
          const inlineKeyMatch = line.match(/^\s*-\s+(\w+):/)
          if (inlineKeyMatch?.[1] === nextSegment) {
            return segIndex + 1 === segments.length - 1
              ? i
              : findSegment(i + 1, segIndex + 2, indent)
          }

          const result = findSegment(i + 1, segIndex + 1, indent)
          if (result !== -1) return result
        }

        listIndex++
      }

      return -1
    }

    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) continue

      const indent = getLineIndent(line)
      if (indent <= parentIndent && i > startLine) break

      const keyMatch = line.match(/^(\s*)(?:-\s+)?([\w-]+):/)
      if (!keyMatch || keyMatch[2] !== segment) continue
      if (indent <= parentIndent && i > startLine) break

      if (segIndex === segments.length - 1) return i

      const result = findSegment(i + 1, segIndex + 1, indent)
      if (result !== -1) return result
    }

    return -1
  }

  return findSegment(0, 0, -1)
}

function updateLineValue(line: string, key: string, replaceVal: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(
    `^(\\s*(?:-\\s*)?${escapedKey}:\\s*)(.+?)(\\s*(?:#.*)?)$`
  )
  const match = line.match(regex)
  if (!match) {
    throw new Error(`Could not update key "${key}" on line: ${line}`)
  }

  const valuePart = match[2].trim()
  const quotedMatch = valuePart.match(/^(['"])(.*)\1$/)
  if (quotedMatch) {
    return `${match[1]}${quotedMatch[1]}${replaceVal}${quotedMatch[1]}${match[3]}`
  }

  return `${match[1]}${replaceVal}${match[3]}`
}

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
  let replaceVal = newValue

  if (type === 'kubernetes' && oldValue && oldValue.includes(':')) {
    const [repo] = oldValue.split(':')
    replaceVal = `${repo}:${newValue}`
  }

  const lineIndex = findLineIndexForYamlPath(content, path)
  if (lineIndex === -1) {
    throw new Error(`Could not find path "${path}" in ${file}`)
  }

  const lines = content.split('\n')
  lines[lineIndex] = updateLineValue(lines[lineIndex], targetKey, replaceVal)
  fs.writeFileSync(file, lines.join('\n'))
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
      lines[i].match(
        new RegExp(`^\\s*(?:-\\s*)?repo:\\s+['"]?${escapedRepo}['"]?\\s*$`)
      )
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
      lines[i].match(
        new RegExp(`^\\s*(?:-\\s*)?repo:\\s+['"]?${escapedRepo}['"]?\\s*$`)
      )
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
