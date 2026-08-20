# Release process

[Back to README](../README.md) · [Development](development.md)

`npm run verify` type-checks, tests, and builds the project. npm also runs the checks and build through `prepublishOnly` and `prepack`, so a broken package cannot be published accidentally.

Inspect the upload before a release:

```bash
npm pack --dry-run
```

Publishing is an external, irreversible action. Confirm that the repository is clean, the version is correct, and the dry-run contents are expected before creating a release.

## Trusted publisher configuration

The package is published through npm trusted publishing. Its npm settings must contain a **GitHub Actions** trusted publisher with these exact values:

- Organization or user: `haseebeqx`
- Repository: `pi-ship`
- Workflow filename: `publish.yml`
- Environment name: leave blank
- Allowed action: `npm publish`

The workflow at `.github/workflows/publish.yml` uses GitHub's OIDC identity and npm provenance, so it does not need an `NPM_TOKEN` secret. For maximum protection, require two-factor authentication and trusted publishing in the package's npm access settings.

## Create a release

Create versions and tags with npm so `package.json` and `npm-shrinkwrap.json` stay synchronized, then publish a GitHub Release for that tag:

```bash
npm version patch # or minor / major
npm run verify
git push origin main --follow-tags
VERSION=$(node -p "require('./package.json').version")
awk -v version="$VERSION" '
  $0 ~ "^## \\[" version "\\]" { found = 1; next }
  found && /^## \[/ { exit }
  found { print }
' CHANGELOG.md > /tmp/pi-ship-release-notes.md
gh release create "v$VERSION" --verify-tag --notes-file /tmp/pi-ship-release-notes.md
```

Use the matching `CHANGELOG.md` section as the release body rather than generated commit links. This gives people and automated tools structured `Added`, `Changed`, `Fixed`, and other release details directly in GitHub's release metadata.

Publishing the GitHub Release triggers `.github/workflows/publish.yml`. The workflow rejects a release whose tag does not exactly match `v<package version>`, runs the package lifecycle checks, and publishes to npm with provenance. CI independently verifies pull requests and pushes on Node.js 22.19.0 and Node.js 24.x.
