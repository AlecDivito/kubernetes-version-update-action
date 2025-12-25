import { jest } from '@jest/globals'
import fs from 'fs'
import { setYamlValue } from '../src/file-updater.js'

describe('file-updater', () => {
  const testFile = 'test-update.yaml'

  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile)
    }
  })

  it('updates a simple value and does not append $3', () => {
    const content = 'image: busybox:1.35'
    fs.writeFileSync(testFile, content)

    setYamlValue(testFile, 'image', '1.37.0', 'kubernetes', false)

    const updated = fs.readFileSync(testFile, 'utf8')
    expect(updated).toBe('image: busybox:1.37.0')
  })

  it('updates a value and preserves trailing comments', () => {
    const content = 'image: busybox:1.35 # stay here'
    fs.writeFileSync(testFile, content)

    setYamlValue(testFile, 'image', '1.37.0', 'kubernetes', false)

    const updated = fs.readFileSync(testFile, 'utf8')
    expect(updated).toBe('image: busybox:1.37.0 # stay here')
  })

  it('handles helm style updates (no repo: in value)', () => {
    const content = 'version: 1.0.0'
    fs.writeFileSync(testFile, content)

    setYamlValue(testFile, 'version', '1.1.0', 'helm', false)

    const updated = fs.readFileSync(testFile, 'utf8')
    expect(updated).toBe('version: 1.1.0')
  })

  it('handles nested paths in kubernetes style', () => {
    const content = `
spec:
  template:
    spec:
      containers:
      - image: myrepo/app:1.0.0
`.trim()
    fs.writeFileSync(testFile, content)

    setYamlValue(
      testFile,
      'spec.template.spec.containers.0.image',
      '1.1.0',
      'kubernetes',
      false
    )

    const updated = fs.readFileSync(testFile, 'utf8')
    expect(updated).toContain('image: myrepo/app:1.1.0')
    expect(updated).not.toContain('$3')
  })
})
