# Version Update Action

![Code coverage](./badges/coverage.svg)

Updates application versions in YAML files (Kubernetes manifests or Helm charts)
and opens Pull Requests with an optional AI-powered risk assessment. One
application per invocation. No cluster access required.

Blog post:
[Keeping my Homelab up to date without losing my mind](https://alecdivito.com/keeping-my-homelab-up-to-date-without-losing-my-mind/).

## Inputs

Requires `contents: write` and `pull-requests: write` on `GITHUB_TOKEN` unless
`dry_run` is `true`.

| Name                     | Description                                                                   | Required | Default                                        |
| ------------------------ | ----------------------------------------------------------------------------- | -------- | ---------------------------------------------- |
| `github_token`           | GitHub token for API requests and Git operations.                             | Yes      | `${{ github.token }}`                          |
| `repo`                   | Upstream repository or image name (e.g. `owner/repo`).                        | Yes      | -                                              |
| `type`                   | `kubernetes` (image tag), `helm` (chart revision), or `manual` (config only). | Yes      | `kubernetes`                                   |
| `source`                 | Version source: `github` or `dockerhub`.                                      | No       | `github`                                       |
| `targets`                | JSON array of `{ "file", "path" }` to update (not used for `manual`).         | No       | -                                              |
| `version`                | Current version (required for `manual`).                                      | No       | -                                              |
| `description`            | Upgrade context for AI analysis and manual PR bodies.                         | No       | -                                              |
| `release_filter`         | Substring filter when a repo publishes many releases.                         | No       | -                                              |
| `version_lag`            | Versions to stay behind latest (e.g. `1`).                                    | No       | `0`                                            |
| `version_lag_depth`      | Lag depth: `major`, `minor`, or `patch`.                                      | No       | `minor`                                        |
| `openai_base_url`        | OpenAI-compatible API base URL.                                               | No       | -                                              |
| `openai_model`           | Model name.                                                                   | No       | -                                              |
| `openai_api_key`         | API key.                                                                      | No       | -                                              |
| `openai_max_note_length` | Max release-note length before chunking for AI.                               | No       | `15000`                                        |
| `max_releases`           | Max releases to fetch/analyze.                                                | No       | `Infinity`                                     |
| `include_prereleases`    | Include prerelease versions.                                                  | No       | `false`                                        |
| `config_file`            | Path to app list for `manual` updates and dead-app cleanup.                   | No       | `versions-config.yaml`                         |
| `dry_run`                | Log only; skip git operations and PR creation.                                | No       | `false`                                        |
| `git_user_name`          | Git commit author name.                                                       | No       | `github-actions[bot]`                          |
| `git_user_email`         | Git commit author email.                                                      | No       | `github-actions[bot]@users.noreply.github.com` |

## How I use it

For a single app, call the action with `repo`, `type`, and `targets`. In my
homelab GitOps repo I pair it with a `versions-config.yaml` and a scheduled
workflow that matrixes over each application.

```
homelab/
├── .github/workflows/update-versions.yaml
├── versions-config.yaml
├── apps/templates/          # ArgoCD Applications, Helm revisions
└── services/                # Deployments, image tags
```

`versions-config.yaml`:

```yaml
applications:
  - repo: 'traefik/traefik-helm-chart'
    type: 'helm'
    file: 'apps/templates/traefik.yaml'
    path: 'spec.source.targetRevision'

  - repo: 'busybox'
    source: 'dockerhub'
    type: 'kubernetes'
    targets:
      - file: 'services/adguard/deployment.yaml'
        path: 'spec.template.spec.initContainers.0.image'
      - file: 'services/vpn/wg-portal/deployment.yaml'
        path: 'spec.template.spec.initContainers.0.image'

  - repo: 'argoproj/argo-cd'
    type: 'manual'
    version: '2.10.1'
    description: |
      ArgoCD is managed via a manual install script. When upgrading:
      1. Run 'kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/v{{version}}/manifests/install.yaml'
      2. Verify all pods are running.
```

`.github/workflows/update-versions.yaml`:

```yaml
name: Update Versions

on:
  schedule:
    - cron: '0 0 * * *'
  workflow_dispatch:

jobs:
  list-apps:
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.set-matrix.outputs.matrix }}
    steps:
      - uses: actions/checkout@v4
      - id: set-matrix
        run: |
          npm install js-yaml
          node -e "
          const fs = require('fs');
          const yaml = require('js-yaml');
          const config = yaml.load(fs.readFileSync('versions-config.yaml', 'utf8'));
          const matrix = {
            include: config.applications.map(app => ({
              ...app,
              targets: app.targets ? JSON.stringify(app.targets) : ''
            }))
          };
          console.log('matrix=' + JSON.stringify(matrix));
          " >> $GITHUB_OUTPUT

  update:
    needs: list-apps
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      max-parallel: 1
      matrix: ${{ fromJson(needs.list-apps.outputs.matrix) }}
    steps:
      - uses: actions/checkout@v4
      - uses: alecdivito/kubernetes-version-update-action@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          repo: ${{ matrix.repo }}
          type: ${{ matrix.type }}
          source: ${{ matrix.source || 'github' }}
          targets: ${{ matrix.targets }}
          version: ${{ matrix.version }}
          description: ${{ matrix.description }}
          release_filter: ${{ matrix.releaseFilter }}
          version_lag: ${{ matrix.versionLag || 0 }}
          version_lag_depth: ${{ matrix.versionLagDepth || 'minor' }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          openai_model: ${{ secrets.OPENAI_MODEL }}
          config_file: 'versions-config.yaml'
```

Config fields use camelCase; map them to [inputs](#inputs) in the workflow (e.g.
`versionLag` → `version_lag`). More examples (Immich version lag, cloudnative-pg
filtering) are in the
[blog post](https://alecdivito.com/keeping-my-homelab-up-to-date-without-losing-my-mind/).

## Contributing

Please remember to run `npm run all` before creating a pull request.

Issues are welcome.

## Testing

You can test this action locally without pushing to GitHub by simulating the
environment variables that GitHub Actions uses.

### 1. Setup Environment

Create a `.env` file in the root directory:

```bash
# .env
INPUT_GITHUB_TOKEN="your_personal_access_token"
INPUT_SOURCE="github"
INPUT_TARGETS='[{"file": "__assets__/test-manifest.yaml", "path": "spec.source.targetRevision"}]'
INPUT_DRY_RUN="true"

# For manual app testing:
# INPUT_TYPE="manual"
# INPUT_VERSION="1.0.0"
# INPUT_REPO="argoproj/argo-cd"
# INPUT_DESCRIPTION="Manual upgrade context..."

# Required for PR simulation logic
GITHUB_REPOSITORY="your-user/your-repo"

# Optional: AI testing
# INPUT_OPENAI_BASE_URL="https://api.openai.com/v1"
# INPUT_OPENAI_MODEL="gpt-4o"
# INPUT_OPENAI_API_KEY="your_key"
```

### 2. Prepare Test Files

Create a dummy YAML file matching your `INPUT_TARGETS`:

```yaml
# test-manifest.yaml
spec:
  source:
    targetRevision: 26.0.0
```

### 3. Run the Action

Since you are using Node 22, you can use the built-in `--env-file` flag to load
your `.env` variables.

```bash
# 1. Build the action to bundle everything
npm run package

# 2. Run the bundled code with your environment variables
node --env-file=.env dist/index.js
```

### Common Issues

- **Missing GITHUB_REPOSITORY**: Ensure `GITHUB_REPOSITORY="owner/repo"` is in
  your `.env`. The action needs this to know where it's running.
- **JSON Parsing Error**: If `INPUT_TARGETS` fails to parse, ensure it is
  wrapped in single quotes in your shell or `.env` file to protect the double
  quotes inside.
- **Permissions**: Ensure your `GITHUB_TOKEN` has `contents: write` and
  `pull-requests: write` permissions if you turn off dry run.
