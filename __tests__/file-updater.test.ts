import { jest } from '@jest/globals'
import fs from 'fs'
import {
  setYamlValue,
  removeApplicationFromConfig,
  updateConfigVersion
} from '../src/file-updater.js'

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

  // ... existing tests ...

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

  describe('removeApplicationFromConfig', () => {
    it('removes an application from a list', () => {
      const content = `
applications:
  - name: 'traefik'
    repo: 'traefik/traefik-helm-chart'
    type: 'helm'
  - name: 'busybox'
    repo: 'busybox'
    source: 'dockerhub'
`.trim()
      fs.writeFileSync(testFile, content)

      removeApplicationFromConfig(testFile, 'traefik/traefik-helm-chart', false)

      const updated = fs.readFileSync(testFile, 'utf8')
      expect(updated).not.toContain('traefik/traefik-helm-chart')
      expect(updated).toContain('busybox')
    })

    it('removes an application when repo is the first key in the list item', () => {
      const content = `
applications:
  - repo: 'argoproj/argo-cd'
    type: 'manual'
    version: 'v2.12.6'
  - repo: 'other/repo'
    version: 'v1.0.0'
`.trim()
      fs.writeFileSync(testFile, content)

      removeApplicationFromConfig(testFile, 'argoproj/argo-cd', false)

      const updated = fs.readFileSync(testFile, 'utf8')
      expect(updated).not.toContain('argoproj/argo-cd')
      expect(updated).toContain('other/repo')
    })
  })

  describe('updateConfigVersion', () => {
    it('updates an existing version field', () => {
      const content = `
applications:
  - name: 'traefik'
    version: 1.0.0
    repo: 'traefik/traefik-helm-chart'
`.trim()
      fs.writeFileSync(testFile, content)

      updateConfigVersion(
        testFile,
        'traefik/traefik-helm-chart',
        '1.1.0',
        false
      )

      const updated = fs.readFileSync(testFile, 'utf8')
      expect(updated).toContain('version: 1.1.0')
    })

    it('updates when repo is the first key in the list item', () => {
      const content = `
applications:
  - repo: 'argoproj/argo-cd'
    type: 'manual'
    version: 'v2.12.6'
`.trim()
      fs.writeFileSync(testFile, content)

      updateConfigVersion(testFile, 'argoproj/argo-cd', 'v3.0.21', false)

      const updated = fs.readFileSync(testFile, 'utf8')
      expect(updated).toContain('version: v3.0.21')
    })

    it('adds a version field if missing', () => {
      const content = `
applications:
  - name: 'traefik'
    repo: 'traefik/traefik-helm-chart'
`.trim()
      fs.writeFileSync(testFile, content)

      updateConfigVersion(
        testFile,
        'traefik/traefik-helm-chart',
        '1.1.0',
        false
      )

      const updated = fs.readFileSync(testFile, 'utf8')
      expect(updated).toContain('version: 1.1.0')
    })
  })

  describe('dry run behavior', () => {
    it('does not throw error if file missing in dry run (remove)', () => {
      expect(() =>
        removeApplicationFromConfig('missing.yaml', 'some-repo', true)
      ).not.toThrow()
    })

    it('does not throw error if file missing in dry run (update)', () => {
      expect(() =>
        updateConfigVersion('missing.yaml', 'some-repo', '1.1.0', true)
      ).not.toThrow()
    })
  })
})
