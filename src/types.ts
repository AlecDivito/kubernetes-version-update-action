export interface Target {
  file: string
  path: string
}

export interface AppConfig {
  repo: string
  type: 'kubernetes' | 'helm' | 'manual'
  source: 'github' | 'dockerhub'
  targets: Target[]
  version?: string
  description?: string
  releaseFilter?: string
  openaiConfig?: {
    baseURL?: string
    model?: string
    apiKey?: string
  }
  maxReleases: number
  dryRun: boolean
  githubToken: string
  gitUserName: string
  gitUserEmail: string
}

export interface Release {
  tag_name: string
  name?: string
  body?: string
  html_url: string
  published_at: string
}

export interface RiskAssessment {
  tag_name: string
  html_url: string
  published_at: string
  summary: string
  worryFree: boolean
  risk: 'None' | 'Low' | 'Medium' | 'High'
  recommendations?: string
}

export interface AggregateRisk {
  releases: RiskAssessment[]
  overallRisk: string
  overallWorryFree: boolean
}
