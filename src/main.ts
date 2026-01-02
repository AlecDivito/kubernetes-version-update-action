import * as core from '@actions/core'
import * as exec from '@actions/exec'
import fs from 'fs'
import { AppConfig, Release, Target } from './types.js'
import { GitHubService, DockerHubService, OpenAIService } from './services.js'
import {
  getYamlValue,
  setYamlValue,
  removeApplicationFromConfig,
  updateConfigVersion
} from './file-updater.js'
import {
  log,
  normalizeVersion,
  formatRisk,
  setGlobalDryRun,
  getRelevantReleases,
  getLogBuffer,
  generatePrBody
} from './utils.js'

export async function run(): Promise<void> {
  try {
    const maxReleasesInput = core.getInput('max_releases')
    const targetsInput = core.getInput('targets')
    const config: AppConfig = {
      repo: core.getInput('repo', { required: true }),
      type: core.getInput('type') as 'kubernetes' | 'helm' | 'manual',
      source: core.getInput('source') as 'github' | 'dockerhub',
      targets: targetsInput ? JSON.parse(targetsInput) : [],
      version: core.getInput('version'),
      description: core.getInput('description'),
      releaseFilter: core.getInput('release_filter'),
      openaiConfig: {
        baseURL: core.getInput('openai_base_url'),
        model: core.getInput('openai_model'),
        apiKey: core.getInput('openai_api_key'),
        maxNoteLength: parseInt(
          core.getInput('openai_max_note_length') || '15000'
        )
      },
      maxReleases:
        maxReleasesInput === 'Infinity' || !maxReleasesInput
          ? Infinity
          : parseInt(maxReleasesInput),
      dryRun: core.getInput('dry_run') === 'true',
      githubToken: core.getInput('github_token', { required: true }),
      gitUserName: core.getInput('git_user_name'),
      gitUserEmail: core.getInput('git_user_email'),
      configFile: core.getInput('config_file') || 'versions-config.yaml'
    }

    setGlobalDryRun(config.dryRun)

    const [owner, repoName] = config.repo.includes('/')
      ? config.repo.split('/')
      : [null, config.repo]

    const displayName = repoName || config.repo

    const ghService = new GitHubService(config.githubToken)
    const dhService = new DockerHubService()
    const aiService = new OpenAIService(config.openaiConfig)

    log(`🪄 Processing application "${displayName}"`)

    let latestRelease: Release | undefined
    let releases: Release[] = []

    let currentVerRaw = ''
    if (config.type === 'manual') {
      currentVerRaw = config.version || ''
    } else {
      try {
        const firstTarget = config.targets[0]
        if (!firstTarget) throw new Error('No targets defined for application')
        currentVerRaw = getYamlValue(firstTarget.file, firstTarget.path) || ''
        if (config.type === 'kubernetes' && currentVerRaw.includes(':')) {
          currentVerRaw = currentVerRaw.split(':')[1]
        }
      } catch (e: unknown) {
        if (
          e instanceof Error &&
          (e.message.includes('File not found') || e.message.includes('ENOENT'))
        ) {
          log(`⚠️ Target file not found for "${displayName}".`)
          if (fs.existsSync(config.configFile)) {
            log(
              `🗑️ Application with repo "${config.repo}" seems to be deleted. Removing from config...`
            )
            const branchName = `bot/remove-${repoName || config.repo}`.replace(
              /\//g,
              '-'
            )
            const prTitle = `chore: remove deleted application ${displayName}`

            if (config.dryRun) {
              log(`💻 git checkout -B ${branchName}`)
              removeApplicationFromConfig(config.configFile, config.repo, true)
              log(`💻 git add ${config.configFile}`)
              log(`💻 git commit -m "${prTitle}"`)
              log(`💻 git push origin ${branchName} --force`)
            } else {
              await exec.exec('git', [
                'config',
                'user.name',
                config.gitUserName
              ])
              await exec.exec('git', [
                'config',
                'user.email',
                config.gitUserEmail
              ])
              await exec.exec('git', ['checkout', '-B', branchName])
              removeApplicationFromConfig(config.configFile, config.repo, false)
              await exec.exec('git', ['add', config.configFile])
              await exec.exec('git', ['commit', '-m', prTitle])
              await exec.exec('git', ['push', 'origin', branchName, '--force'])

              const [contextOwner, contextRepo] =
                process.env.GITHUB_REPOSITORY!.split('/')
              await ghService.createOrUpdatePullRequest(
                contextOwner,
                contextRepo,
                prTitle,
                branchName,
                'main',
                `The application **${displayName}** was tracked in the configuration but its target files are missing. This PR removes it from the tracking configuration.`,
                [{ name: 'cleanup', color: 'cccccc' }]
              )
            }
            return
          } else {
            log(`⚠️ ${config.configFile} not found. Skipping auto-removal.`)
          }
        }
        throw e
      }
    }

    if (config.source === 'dockerhub') {
      latestRelease = await dhService.fetchLatestTag(config.repo)
    } else {
      if (!owner || !repoName)
        throw new Error(`Invalid repo format for GitHub source: ${config.repo}`)

      releases = await ghService.fetchAllReleases(
        owner,
        repoName,
        currentVerRaw,
        config.maxReleases
      )

      if (config.releaseFilter) {
        const filtered = releases.find(
          (r) =>
            r.tag_name.includes(config.releaseFilter!) ||
            (r.name && r.name.includes(config.releaseFilter!))
        )
        if (!filtered)
          throw new Error(
            `No release found matching filter: ${config.releaseFilter}`
          )
        latestRelease = filtered
      } else {
        latestRelease = releases[0]
      }
    }

    if (!latestRelease) {
      log(`✅ "${displayName}" is already up to date or no releases found.`)
      return
    }

    const latestVerNormalized = normalizeVersion(latestRelease.tag_name)
    const updatesNeeded: {
      target?: Target
      currentVerRaw: string
      targetVersion: string
      isManual?: boolean
    }[] = []

    const currentVersionFrom = normalizeVersion(currentVerRaw)

    if (config.type === 'manual') {
      if (
        latestVerNormalized &&
        currentVersionFrom &&
        latestVerNormalized !== currentVersionFrom
      ) {
        const targetVersion =
          currentVerRaw.startsWith('v') && !latestVerNormalized.startsWith('v')
            ? `v${latestVerNormalized}`
            : latestVerNormalized
        updatesNeeded.push({
          currentVerRaw,
          targetVersion,
          isManual: true
        })
      }
    } else {
      for (const target of config.targets) {
        let tCurrentVerRaw = getYamlValue(target.file, target.path) || ''
        if (config.type === 'kubernetes' && tCurrentVerRaw.includes(':')) {
          tCurrentVerRaw = tCurrentVerRaw.split(':')[1]
        }

        const tCurrentVerNormalized = normalizeVersion(tCurrentVerRaw)
        if (
          latestVerNormalized &&
          tCurrentVerNormalized &&
          latestVerNormalized !== tCurrentVerNormalized
        ) {
          const targetVersion =
            tCurrentVerRaw.startsWith('v') &&
            !latestVerNormalized.startsWith('v')
              ? `v${latestVerNormalized}`
              : latestVerNormalized

          updatesNeeded.push({
            target,
            currentVerRaw: tCurrentVerRaw,
            targetVersion
          })
        }
      }
    }

    if (updatesNeeded.length === 0) {
      log(
        `✅ "${displayName}" is already up to date (${latestRelease.tag_name})`
      )
      return
    }

    log(
      `💡 Latest version is ${latestRelease.tag_name} (${latestVerNormalized})`
    )

    // Get all releases that are part of this update
    const currentVerRawForReleases = updatesNeeded[0].currentVerRaw
    const sourceReleases =
      config.source === 'dockerhub' ? [latestRelease] : releases
    const relevantReleases = getRelevantReleases(
      sourceReleases,
      currentVerRawForReleases,
      config.maxReleases
    )

    let aiAssessment = null
    if (config.openaiConfig?.apiKey && relevantReleases.length > 0) {
      aiAssessment = await aiService.analyzeRisks(
        displayName,
        currentVerRawForReleases,
        relevantReleases,
        config.openaiConfig.model!,
        config.maxReleases,
        config.description,
        config.openaiConfig.maxNoteLength
      )
    } else if (relevantReleases.length > 0) {
      log('⚠️ AI analysis skipped: OPENAI_API_KEY is not configured.')
    }

    log(
      `🚀 Updating ${displayName} (${config.repo}): ${updatesNeeded.length} target(s) need updates`
    )

    if (aiAssessment) {
      log(
        `📊 AI Overall Risk: [${formatRisk(aiAssessment.overallRisk)}] ${aiAssessment.overallWorryFree ? '✅ Worry-free' : '⚠️ Proceed with caution'}`
      )
      for (const rel of aiAssessment.releases) {
        const dateStr = rel.published_at
          ? new Date(rel.published_at).toLocaleDateString()
          : 'unknown date'
        log(
          `   - ${rel.tag_name} (${dateStr}): [${formatRisk(rel.risk)}] ${rel.summary}`
        )
        if (rel.risk !== 'None' && rel.recommendations) {
          log(`     💡 Recommendation: ${rel.recommendations}`)
        }
      }
    } else {
      log(`📦 Found ${relevantReleases.length} release(s) to apply.`)
      for (const rel of relevantReleases) {
        const dateStr = rel.published_at
          ? new Date(rel.published_at).toLocaleDateString()
          : 'unknown date'
        log(`   - ${rel.tag_name} (${dateStr})`)
      }
    }

    const branchName =
      `bot/update-${repoName || config.repo}-${latestVerNormalized}`.replace(
        /\//g,
        '-'
      )

    const prTitle = `chore: update ${displayName} from ${currentVersionFrom} to ${latestVerNormalized}`

    if (config.dryRun) {
      log(`💻 git config user.name "${config.gitUserName}"`)
      log(`💻 git config user.email "${config.gitUserEmail}"`)
      log(`💻 git checkout -B ${branchName}`)
      for (const update of updatesNeeded) {
        if (update.isManual) {
          log(
            `   - ${config.configFile} -> ${displayName}: ${update.currentVerRaw} -> ${update.targetVersion}`
          )
          updateConfigVersion(
            config.configFile,
            config.repo,
            update.targetVersion,
            true
          )
          log(`💻 git add ${config.configFile}`)
        } else if (update.target) {
          log(
            `   - ${update.target.file} -> ${update.target.path}: ${update.currentVerRaw} -> ${update.targetVersion}`
          )
          setYamlValue(
            update.target.file,
            update.target.path,
            update.targetVersion,
            config.type as 'kubernetes' | 'helm',
            true
          )
          log(`💻 git add ${update.target.file}`)
        }
      }
      log(`💻 git commit -m "${prTitle}"`)
      log(`💻 git push origin ${branchName} --force`)
      log(`💻 git checkout main`)
      log(`\n👏 All checks completed.`)
      return
    }

    // Git Operations
    // -B will create the branch if it doesn't exist, or reset it if it does
    await exec.exec('git', ['config', 'user.name', config.gitUserName])
    await exec.exec('git', ['config', 'user.email', config.gitUserEmail])
    await exec.exec('git', ['checkout', '-B', branchName])

    for (const update of updatesNeeded) {
      if (update.isManual) {
        log(
          `   - ${config.configFile} -> ${displayName}: ${update.currentVerRaw} -> ${update.targetVersion}`
        )
        updateConfigVersion(
          config.configFile,
          config.repo,
          update.targetVersion,
          false
        )
        await exec.exec('git', ['add', config.configFile])
      } else if (update.target) {
        log(
          `   - ${update.target.file} -> ${update.target.path}: ${update.currentVerRaw} -> ${update.targetVersion}`
        )
        setYamlValue(
          update.target.file,
          update.target.path,
          update.targetVersion,
          config.type as 'kubernetes' | 'helm',
          false
        )
        await exec.exec('git', ['add', update.target.file])
      }
    }

    await exec.exec('git', ['commit', '-m', prTitle])
    await exec.exec('git', ['push', 'origin', branchName, '--force'])

    // PR Creation
    const prBody = generatePrBody(
      displayName,
      aiAssessment,
      relevantReleases,
      getLogBuffer()
    )

    const [contextOwner, contextRepo] =
      process.env.GITHUB_REPOSITORY!.split('/')

    const labels: { name: string; color: string }[] = []
    if (aiAssessment) {
      const riskColors: Record<string, string> = {
        None: '0e8a16',
        Low: 'fbca04',
        Medium: 'e99695',
        High: 'd93f0b'
      }
      labels.push({
        name: `Risk: ${aiAssessment.overallRisk}`,
        color: riskColors[aiAssessment.overallRisk] || 'cccccc'
      })
      if (aiAssessment.overallWorryFree) {
        labels.push({ name: 'Worry-free', color: 'c2e0c6' })
      }
    }

    await ghService.createOrUpdatePullRequest(
      contextOwner,
      contextRepo,
      prTitle,
      branchName,
      'main',
      prBody,
      labels
    )

    await exec.exec('git', ['checkout', 'main'])
  } catch (error: unknown) {
    core.setFailed(error instanceof Error ? error.message : 'Unknown error')
  }
}
