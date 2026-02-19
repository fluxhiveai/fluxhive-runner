# Releasing FluxHive Runner (GitHub Releases)

This repo ships the runner as a single executable file: `fluxhive-runner.mjs`.

## Create A Release

1. Tag (from repo root):

```bash
git tag v0.1.0
git push origin v0.1.0
```

2. GitHub Actions workflow `runner-release` builds and uploads assets:
- `fluxhive-runner.mjs`
- `fluxhive-runner.mjs.sha256`

## Download

From a public repo, the "latest" URLs look like:

```text
https://github.com/<owner>/<repo>/releases/latest/download/fluxhive-runner.mjs
https://github.com/<owner>/<repo>/releases/latest/download/fluxhive-runner.mjs.sha256
```

## Note On Public vs Private

If the GitHub repository is private, release assets are not publicly downloadable.
For a public “installer” experience, put the runner in a separate public repo (recommended),
or make this repo public.

