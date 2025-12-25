import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { AppConfig, Release, Target } from "./types.js";
import { GitHubService, DockerHubService, OpenAIService } from "./services.js";
import { getYamlValue, setYamlValue } from "./file-updater.js";
import { log, normalizeVersion, formatRisk, setGlobalDryRun } from "./utils.js";

export async function run(): Promise<void> {
  try {
    const config: AppConfig = {
      repo: core.getInput("repo", { required: true }),
      type: core.getInput("type") as 'kubernetes' | 'helm',
      source: core.getInput("source") as 'github' | 'dockerhub',
      targets: JSON.parse(core.getInput("targets", { required: true })),
      releaseFilter: core.getInput("release_filter"),
      openaiConfig: {
        baseURL: core.getInput("openai_base_url"),
        model: core.getInput("openai_model"),
        apiKey: core.getInput("openai_api_key"),
      },
      maxReleases: core.getInput("max_releases") === "Infinity" || !core.getInput("max_releases")
        ? Infinity 
        : parseInt(core.getInput("max_releases")),
      dryRun: core.getInput("dry_run") === "true",
      githubToken: core.getInput("github_token", { required: true }),
    };

    setGlobalDryRun(config.dryRun);

    const [owner, repoName] = config.repo.includes("/") 
      ? config.repo.split("/") 
      : [null, config.repo];
    
    const displayName = repoName;

    const ghService = new GitHubService(config.githubToken);
    const dhService = new DockerHubService();
    const aiService = new OpenAIService(config.openaiConfig);

    log(`🪄 Processing application "${displayName}"`);

    let latestRelease: Release;
    let releases: Release[] = [];

    if (config.source === "dockerhub") {
      latestRelease = await dhService.fetchLatestTag(config.repo);
    } else {
      if (!owner) throw new Error(`Invalid repo format for GitHub source: ${config.repo}`);
      const firstTarget = config.targets[0];
      let currentVerRaw = getYamlValue(firstTarget.file, firstTarget.path) || "";
      if (config.type === "kubernetes" && currentVerRaw.includes(":")) {
        currentVerRaw = currentVerRaw.split(":")[1];
      }

      releases = await ghService.fetchAllReleases(owner, repoName, currentVerRaw, config.maxReleases);
      
      if (config.releaseFilter) {
        const filtered = releases.find(r => 
          r.tag_name.includes(config.releaseFilter!) || (r.name && r.name.includes(config.releaseFilter!))
        );
        if (!filtered) throw new Error(`No release found matching filter: ${config.releaseFilter}`);
        latestRelease = filtered;
      } else {
        latestRelease = releases[0];
      }
    }

    if (!latestRelease) {
      log(`✅ "${displayName}" is already up to date or no releases found.`);
      return;
    }

    const latestVerNormalized = normalizeVersion(latestRelease.tag_name);
    const updatesNeeded: { target: Target; currentVerRaw: string; targetVersion: string }[] = [];

    for (const target of config.targets) {
      let currentVerRaw = getYamlValue(target.file, target.path) || "";
      if (config.type === "kubernetes" && currentVerRaw.includes(":")) {
        currentVerRaw = currentVerRaw.split(":")[1];
      }

      const currentVerNormalized = normalizeVersion(currentVerRaw);
      if (latestVerNormalized && currentVerNormalized && latestVerNormalized !== currentVerNormalized) {
        const targetVersion = currentVerRaw.startsWith("v") && !latestVerNormalized.startsWith("v")
          ? `v${latestVerNormalized}`
          : latestVerNormalized;

        updatesNeeded.push({ target, currentVerRaw, targetVersion });
      }
    }

    if (updatesNeeded.length === 0) {
      log(`✅ "${displayName}" is already up to date (${latestRelease.tag_name})`);
      return;
    }

    log(`💡 Latest version is ${latestRelease.tag_name} (${latestVerNormalized})`);
    
    let aiAssessment = null;
    if (config.openaiConfig?.apiKey) {
      const currentVer = updatesNeeded[0].currentVerRaw;
      aiAssessment = await aiService.analyzeRisks(
        displayName, 
        currentVer, 
        config.source === "dockerhub" ? [latestRelease] : releases, 
        config.openaiConfig.model!,
        config.maxReleases
      );
    }

    log(`🚀 Updating ${displayName} (${config.repo}): ${updatesNeeded.length} target(s) need updates`);
    if (aiAssessment) {
      log(`📊 AI Overall Risk: [${formatRisk(aiAssessment.overallRisk)}] ${aiAssessment.overallWorryFree ? "✅ Worry-free" : "⚠️ Proceed with caution"}`);
      for (const rel of aiAssessment.releases) {
        const dateStr = rel.published_at ? new Date(rel.published_at).toLocaleDateString() : "unknown date";
        log(`   - ${rel.tag_name} (${dateStr}): [${formatRisk(rel.risk)}] ${rel.summary}`);
        if (rel.risk !== "None" && rel.recommendations) {
          log(`     💡 Recommendation: ${rel.recommendations}`);
        }
      }
    }

    const branchName = `bot/update-${repoName}-${latestVerNormalized}`.replace(/\//g, "-");
    
    if (config.dryRun) {
      log(`💻 git checkout -b ${branchName}`);
      for (const update of updatesNeeded) {
        log(`   - ${update.target.file} -> ${update.target.path}: ${update.currentVerRaw} -> ${update.targetVersion}`);
        setYamlValue(update.target.file, update.target.path, update.targetVersion, config.type, true);
        log(`💻 git add ${update.target.file}`);
      }
      log(`💻 git commit -m "chore: bump ${displayName} to ${latestVerNormalized}"`);
      log(`💻 git push origin ${branchName}`);
      log(`💻 git checkout main`);
      log(`\n👏 All checks completed.`);
      return;
    }

    // Git Operations
    await exec.exec("git", ["checkout", "-b", branchName]);
    
    for (const update of updatesNeeded) {
      log(`   - ${update.target.file} -> ${update.target.path}: ${update.currentVerRaw} -> ${update.targetVersion}`);
      setYamlValue(update.target.file, update.target.path, update.targetVersion, config.type, false);
      await exec.exec("git", ["add", update.target.file]);
    }

    await exec.exec("git", ["commit", "-m", `chore: bump ${displayName} to ${latestVerNormalized}`]);
    await exec.exec("git", ["push", "origin", branchName]);

    // PR Creation
    let body = `Automated version update for ${displayName}.\n\n[Latest Release Notes](${latestRelease.html_url})`;
    if (aiAssessment) {
      body += `\n\n### 🤖 AI Risk Assessment\n- **Overall Risk Level**: ${formatRisk(aiAssessment.overallRisk)}\n- **Overall Worry Free**: ${aiAssessment.overallWorryFree ? "Yes" : "No"}\n\n#### Detailed Release Summaries\n`;
      for (const rel of aiAssessment.releases) {
        const dateStr = rel.published_at ? new Date(rel.published_at).toLocaleDateString() : "unknown date";
        body += `- **[${rel.tag_name}](${rel.html_url})** (${dateStr}) (Risk: ${formatRisk(rel.risk)}, Worry-free: ${rel.worryFree ? "Yes" : "No"})\n  ${rel.summary}\n`;
        if (rel.risk !== "None" && rel.recommendations) {
          body += `  > **💡 Recommendation:** ${rel.recommendations}\n`;
        }
      }
    }

    const [contextOwner, contextRepo] = process.env.GITHUB_REPOSITORY!.split("/");
    await ghService.createPullRequest(
      contextOwner,
      contextRepo,
      `chore: update ${displayName} to ${latestVerNormalized}`,
      branchName,
      "main",
      body
    );

    await exec.exec("git", ["checkout", "main"]);

  } catch (error: any) {
    core.setFailed(error.message);
  }
}
