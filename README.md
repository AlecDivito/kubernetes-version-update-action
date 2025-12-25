# Version Update Action

A GitHub Action that automatically updates application versions in YAML files (Kubernetes manifests or Helm charts) and creates Pull Requests with an AI-powered risk assessment.

## Usage

This action is designed to be run for a single application at a time. To update multiple applications, you can use a workflow with a matrix or a loop.

### Example Workflow

This example shows how to read a `versions-config.yaml` file and loop through the applications using a GitHub Actions matrix. This approach uses a small Node.js script to ensure robust parsing.

```yaml
name: Update Versions

on:
  schedule:
    - cron: '0 0 * * *' # Run daily
  workflow_dispatch:

jobs:
  list-apps:
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.set-matrix.outputs.matrix }}
    steps:
      - uses: actions/checkout@v4
      - id: set-matrix
        name: Generate Matrix
        run: |
          node -e "
          const fs = require('fs');
          const yaml = require('js-yaml');
          const config = yaml.load(fs.readFileSync('versions-config.yaml', 'utf8'));
          const matrix = {
            include: config.applications.map(app => ({
              ...app,
              targets: JSON.stringify(app.targets || [{file: app.file, path: app.path}])
            }))
          };
          console.log('matrix=' + JSON.stringify(matrix));
          " >> $GITHUB_OUTPUT

  update:
    needs: list-apps
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix: ${{ fromJson(needs.list-apps.outputs.matrix) }}
    steps:
      - uses: actions/checkout@v4
      - name: Update ${{ matrix.name }}
        uses: ./ # Path to this action
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          repo: ${{ matrix.repo }}
          type: ${{ matrix.type }}
          source: ${{ matrix.source || 'github' }}
          targets: ${{ matrix.targets }}
          release_filter: ${{ matrix.releaseFilter }}
          openai_base_url: ${{ secrets.OPENAI_BASE_URL }}
          openai_model: ${{ secrets.OPENAI_MODEL }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

### Configuration (`versions-config.yaml`)

```yaml
applications:
  - name: "traefik"
    repo: "traefik/traefik-helm-chart"
    type: "helm"
    file: "apps/templates/public-ingress.yaml"
    path: "spec.source.targetRevision"
  - name: "busybox"
    repo: "busybox"
    source: "dockerhub"
    type: "kubernetes"
    targets:
      - file: "services/adguard/deployment.yaml"
        path: "spec.template.spec.initContainers.0.image"
      - file: "services/vpn/wg-portal/deployment.yaml"
        path: "spec.template.spec.initContainers.0.image"
```

## Inputs

| Name | Description | Required | Default |
| --- | --- | --- | --- |
| `github_token` | GitHub token for API requests and git operations. | Yes | `${{ github.token }}` |
| `repo` | Repository where the application source or image is located (e.g., owner/repo). | Yes | - |
| `type` | Type of update (`kubernetes` or `helm`). | Yes | `kubernetes` |
| `source` | Source of version information (`github` or `dockerhub`). | Yes | `github` |
| `targets` | JSON array of target files and paths to update. | Yes | - |
| `release_filter` | Optional filter for releases. | No | - |
| `openai_base_url` | Base URL for OpenAI API. | No | - |
| `openai_model` | Model name for OpenAI API. | No | - |
| `openai_api_key` | API key for OpenAI. | No | - |
| `max_releases` | Maximum number of releases to analyze. | No | `Infinity` |
| `dry_run` | If `true`, only log changes and do not perform git operations or PR creation. | No | `false` |

## Local Development & Testing

You can test this action locally without pushing to GitHub by simulating the environment variables that GitHub Actions uses.

### 1. Setup Environment
Create a `.env` file in the root directory:

```bash
# .env
INPUT_GITHUB_TOKEN="your_personal_access_token"
INPUT_REPO="traefik/traefik-helm-chart"
INPUT_TYPE="helm"
INPUT_SOURCE="github"
INPUT_TARGETS='[{"file": "__assets__/test-manifest.yaml", "path": "spec.source.targetRevision"}]'
INPUT_DRY_RUN="true"

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

Since you are using Node 22, you can use the built-in `--env-file` flag to load your `.env` variables.

```bash
# 1. Build the action to bundle everything
npm run package

# 2. Run the bundled code with your environment variables
node --env-file=.env dist/index.js
```

### Common Issues

*   **Missing GITHUB_REPOSITORY**: Ensure `GITHUB_REPOSITORY="owner/repo"` is in your `.env`. The action needs this to know where it's running.
*   **JSON Parsing Error**: If `INPUT_TARGETS` fails to parse, ensure it is wrapped in single quotes in your shell or `.env` file to protect the double quotes inside.
*   **Permissions**: Ensure your `GITHUB_TOKEN` has `contents: write` and `pull-requests: write` permissions if you turn off dry run.
