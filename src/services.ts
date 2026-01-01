import * as github from '@actions/github'
import https from 'https'
import { OpenAI as OpenAIClient } from 'openai'
import { AppConfig, Release, RiskAssessment, AggregateRisk } from './types.js'
import { log, normalizeVersion } from './utils.js'

export class GitHubService {
  private octokit: ReturnType<typeof github.getOctokit>

  constructor(token: string) {
    this.octokit = github.getOctokit(token)
  }

  async fetchAllReleases(
    owner: string,
    repo: string,
    currentVersion: string,
    maxReleases: number
  ): Promise<Release[]> {
    const cur = normalizeVersion(currentVersion)
    // If maxReleases is Infinity, we'll fetch up to 20 pages (600 releases) as a safety limit.
    // Otherwise, fetch enough pages to cover maxReleases + a buffer to find 'cur'.
    const MAX_PAGES =
      maxReleases === Infinity ? 20 : Math.ceil(maxReleases / 30) + 2
    const maxLog = maxReleases === Infinity ? 'No Limit' : maxReleases

    let allReleases: Release[] = []
    log(
      `☎️  Fetching releases for ${owner}/${repo} until ${currentVersion || 'latest'} (Max: ${maxLog})...`
    )

    for (let page = 1; page <= MAX_PAGES; page++) {
      log(
        `☎️  Calling github GET https://api.github.com/repos/${owner}/${repo}/releases?page=${page}&per_page=30`
      )
      const { data: releases } = await this.octokit.rest.repos.listReleases({
        owner,
        repo,
        page,
        per_page: 30
      })

      if (!releases || releases.length === 0) break

      const formattedReleases: Release[] = releases.map((r) => ({
        tag_name: r.tag_name,
        name: r.name || undefined,
        body: r.body || undefined,
        html_url: r.html_url,
        published_at: r.published_at || r.created_at
      }))

      allReleases = allReleases.concat(formattedReleases)

      if (!cur) break
      const found = releases.find((r) => normalizeVersion(r.tag_name) === cur)
      if (found) {
        log(`✅ Found current version ${currentVersion} at page ${page}`)
        break
      }
    }

    return allReleases
  }

  async createOrUpdatePullRequest(
    owner: string,
    repo: string,
    title: string,
    head: string,
    base: string,
    body: string,
    labels: { name: string; color: string }[] = []
  ): Promise<void> {
    // Check if PR already exists
    const { data: pullRequests } = await this.octokit.rest.pulls.list({
      owner,
      repo,
      head: `${owner}:${head}`,
      base,
      state: 'open'
    })

    let prNumber: number

    if (pullRequests.length > 0) {
      prNumber = pullRequests[0].number
      log(`☎️  Updating existing Pull Request #${prNumber}: ${title}`)
      await this.octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: prNumber,
        title,
        body
      })
    } else {
      log(`☎️  Creating new Pull Request: ${title}`)
      const { data: newPr } = await this.octokit.rest.pulls.create({
        owner,
        repo,
        title,
        head,
        base,
        body
      })
      prNumber = newPr.number
    }

    if (labels.length > 0) {
      log(`🏷️  Ensuring labels exist: ${labels.map((l) => l.name).join(', ')}`)
      for (const label of labels) {
        try {
          await this.octokit.rest.issues.getLabel({
            owner,
            repo,
            name: label.name
          })
        } catch {
          log(`➕ Creating missing label: ${label.name}`)
          await this.octokit.rest.issues.createLabel({
            owner,
            repo,
            name: label.name,
            color: label.color
          })
        }
      }

      log(`☎️  Adding labels to PR #${prNumber}`)
      await this.octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: prNumber,
        labels: labels.map((l) => l.name)
      })
    }
  }
}

export class DockerHubService {
  async fetchLatestTag(repo: string): Promise<Release> {
    return new Promise((resolve, reject) => {
      const isOfficial = !repo.includes('/')
      const fullRepo = isOfficial ? `library/${repo}` : repo
      const url = `https://hub.docker.com/v2/repositories/${fullRepo}/tags?page_size=20&ordering=last_updated`

      log(`☎️  Calling Docker Hub GET ${url}`)

      https
        .get(url, { headers: { 'User-Agent': 'version-bumper' } }, (res) => {
          let data = ''
          res.on('data', (c) => (data += c))
          res.on('end', () => {
            if (res.statusCode! >= 400) return reject(new Error(data))
            const json = JSON.parse(data)
            const versionTags = json.results.filter((t: { name: string }) =>
              /^\d+\.\d+(\.\d+)?$/.test(t.name)
            )
            const latestTag =
              versionTags[0] ||
              json.results.find((t: { name: string }) => t.name !== 'latest') ||
              json.results[0]

            if (latestTag) {
              resolve({
                tag_name: latestTag.name,
                published_at: latestTag.last_updated,
                html_url: `https://hub.docker.com/_/${isOfficial ? repo : repo}`
              })
            } else {
              reject(new Error(`No tags found for ${repo}`))
            }
          })
        })
        .on('error', reject)
    })
  }
}

export class OpenAIService {
  private openai: OpenAIClient | null = null

  constructor(config?: AppConfig['openaiConfig']) {
    if (config?.apiKey && config?.baseURL && config?.model) {
      this.openai = new OpenAIClient({
        baseURL: config.baseURL,
        apiKey: config.apiKey
      })
    }
  }

  async analyzeRelease(
    appName: string,
    release: Release,
    model: string,
    description?: string,
    maxNoteLength = 15000
  ): Promise<RiskAssessment> {
    if (!this.openai) {
      return {
        tag_name: release.tag_name,
        html_url: release.html_url,
        published_at: release.published_at,
        summary: 'AI analysis skipped (not configured).',
        worryFree: false,
        risk: 'High'
      }
    }

    const descriptionContext = description
      ? `\nAdditional Context/Instructions for this application:\n${description}\n`
      : ''

    const releaseNotes = release.body || 'No release notes provided.'
    const MAX_NOTE_LENGTH = maxNoteLength

    const getPrompt = (
      notes: string
    ) => `You are a DevOps assistant helping to assess the risk of a single release for "${appName}".${descriptionContext}
Release Name/Tag: ${release.name || release.tag_name}
Release Notes:
${notes}

Task:
1. Provide a very short summary of the most important changes in this specific release.
2. Determine if this specific release should be "worry free" (true/false).
3. Assign a risk level for this specific release: None, Low, Medium, or High.
4. If risk is Low, Medium, or High, provide concise recommendations or required changes. If risk is None, this can be an empty string.
5. If Additional Context/Instructions were provided, ensure the summary and recommendations take them into account.

Respond ONLY in JSON format:
{
  "summary": "string",
  "worryFree": boolean,
  "risk": "None" | "Low" | "Medium" | "High",
  "recommendations": "string"
}`

    try {
      log(`🤖 Analyzing release ${release.tag_name} for ${appName}...`)

      if (releaseNotes.length <= MAX_NOTE_LENGTH) {
        const response = await this.openai.chat.completions.create({
          model: model,
          messages: [{ role: 'user', content: getPrompt(releaseNotes) }],
          response_format: { type: 'json_object' }
        })
        const assessment = JSON.parse(
          response.choices[0].message.content || '{}'
        )
        return {
          tag_name: release.tag_name,
          html_url: release.html_url,
          published_at: release.published_at,
          ...assessment
        }
      }

      // Handle long release notes by chunking
      log(
        `⚠️ Release notes for ${release.tag_name} are too long (${releaseNotes.length} chars). Chunking...`
      )
      const chunks: string[] = []
      for (let i = 0; i < releaseNotes.length; i += MAX_NOTE_LENGTH) {
        chunks.push(releaseNotes.slice(i, i + MAX_NOTE_LENGTH))
      }

      const chunkAssessments: RiskAssessment[] = []
      for (let i = 0; i < chunks.length; i++) {
        log(`   - Processing chunk ${i + 1}/${chunks.length}...`)
        const response = await this.openai.chat.completions.create({
          model: model,
          messages: [
            {
              role: 'user',
              content: getPrompt(
                `PART ${i + 1} of ${chunks.length}:\n${chunks[i]}`
              )
            }
          ],
          response_format: { type: 'json_object' }
        })
        chunkAssessments.push(
          JSON.parse(response.choices[0].message.content || '{}')
        )
      }

      // Aggregate chunk results
      log(`🤖 Aggregating ${chunks.length} chunk assessments...`)
      const aggregatePrompt = `I have analyzed a very large release notes document for "${appName}" in ${chunks.length} parts.
Here are the summaries and risk assessments for each part:

${chunkAssessments
  .map(
    (a, i) =>
      `Part ${i + 1}:
Summary: ${a.summary}
Risk: ${a.risk}
Recommendations: ${a.recommendations || 'None'}`
  )
  .join('\n\n')}

Task:
Synthesize these assessments into a single coherent overall assessment for the ENTIRE release.
1. Summary: A single concise summary of the most critical changes.
2. WorryFree: True only if ALL parts were worry-free.
3. Risk: The highest risk level found in any part (None < Low < Medium < High).
4. Recommendations: A synthesized list of all unique and critical recommendations.

Respond ONLY in JSON format:
{
  "summary": "string",
  "worryFree": boolean,
  "risk": "None" | "Low" | "Medium" | "High",
  "recommendations": "string"
}`

      const finalResponse = await this.openai.chat.completions.create({
        model: model,
        messages: [{ role: 'user', content: aggregatePrompt }],
        response_format: { type: 'json_object' }
      })

      const finalAssessment = JSON.parse(
        finalResponse.choices[0].message.content || '{}'
      )
      return {
        tag_name: release.tag_name,
        html_url: release.html_url,
        published_at: release.published_at,
        ...finalAssessment
      }
    } catch (e: unknown) {
      log(
        `⚠️ AI analysis failed for ${release.tag_name}: ${e instanceof Error ? e.message : 'Unknown error'}`
      )
      return {
        tag_name: release.tag_name,
        html_url: release.html_url,
        published_at: release.published_at,
        summary: 'Failed to analyze release.',
        worryFree: false,
        risk: 'High'
      }
    }
  }

  async analyzeRisks(
    appName: string,
    currentVersion: string,
    releases: Release[],
    model: string,
    maxReleases: number,
    description?: string,
    maxNoteLength = 15000
  ): Promise<AggregateRisk | null> {
    if (!this.openai || releases.length === 0) return null

    const cur = normalizeVersion(currentVersion)
    const relevantReleases: Release[] = []

    for (const r of releases) {
      const tag = normalizeVersion(r.tag_name)
      if (tag === cur) break
      relevantReleases.push(r)
      if (relevantReleases.length >= maxReleases) break
    }

    if (relevantReleases.length === 0) return null

    log(
      `🤖 Starting individual analysis for ${relevantReleases.length} releases...`
    )
    const assessments = await Promise.all(
      relevantReleases.map((r) =>
        this.analyzeRelease(appName, r, model, description, maxNoteLength)
      )
    )

    const riskLevels: ('None' | 'Low' | 'Medium' | 'High')[] = [
      'None',
      'Low',
      'Medium',
      'High'
    ]
    const maxRiskIndex = assessments.reduce((max, a) => {
      const idx = riskLevels.indexOf(a.risk)
      return idx > max ? idx : max
    }, 0)

    return {
      releases: assessments,
      overallRisk: riskLevels[maxRiskIndex],
      overallWorryFree: assessments.every((a) => a.worryFree)
    }
  }
}
