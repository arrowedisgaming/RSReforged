# Releasing RSReforged

The release flow is tag-driven. Pushing a tag of the form `release-X.Y.Z`
triggers `.github/workflows/release.yml`, which builds the distribution zip
and creates a GitHub Release with the artifacts Foundry needs.

## Steps for a new release

1. **Decide the version.** Follow [SemVer](https://semver.org/):
   - Patch (`X.Y.Z+1`): bug fixes only, no API or settings changes.
   - Minor (`X.Y+1.0`): new features, backwards-compatible.
   - Major (`X+1.0.0`): breaking changes (e.g. dropping a Foundry version).

2. **Bump `module.json`.** Update three fields:
   - `version`: the new version string (no `release-` prefix).
   - `compatibility.verified`: the latest Foundry build you actually tested on.
   - `download`: the URL to the zip the workflow will produce, of the form
     `https://github.com/arrowedisgaming/RSReforged/releases/download/release-X.Y.Z/rsreforged-release-X.Y.Z.zip`.

3. **Update `CHANGELOG.md`.** Move items from `[Unreleased]` into a new
   `[X.Y.Z] — YYYY-MM-DD` section. Add the SemVer comparison link at the
   bottom of the file.

4. **Commit.**
   ```
   git commit -am "release: X.Y.Z"
   ```

5. **Tag and push.**
   ```
   git tag release-X.Y.Z
   git push origin master --tags
   ```

6. **Watch the workflow.** It will:
   - Verify `module.json` version matches the tag (fails fast if not).
   - Build `rsreforged-release-X.Y.Z.zip` containing
     `module.json, LICENSE, README.md, src/, css/, lang/, templates/`.
   - Create a GitHub Release with the zip + a copy of `module.json` attached.

7. **Smoke-test the install.** In a clean Foundry v14 instance, paste the
   manifest URL into *Install Module*:
   ```
   https://raw.githubusercontent.com/arrowedisgaming/RSReforged/master/module.json
   ```
   Confirm the version reads correctly and the module enables without errors.

## If the workflow fails

- **"module.json says version=A but tag says version=B"** — you tagged
  before bumping `module.json`. Delete the tag locally and on the remote
  (`git tag -d release-X.Y.Z; git push origin :refs/tags/release-X.Y.Z`),
  fix `module.json`, re-tag, and push again. Don't try to amend the tag in
  place.
- **"fail_on_unmatched_files"** — the zip step didn't run or wrote a
  differently-named file. Check the Build step's output.
- **softprops/action-gh-release auth error** — the `GITHUB_TOKEN` should
  already have the `contents: write` permission (set at job level in
  `release.yml`). If you forked the repo, GitHub may have disabled
  workflow runs by default — re-enable them in repo *Settings → Actions*.
