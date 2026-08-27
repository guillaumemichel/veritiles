# Releasing

The repeatable runbook for cutting a `veritiles` release. Replace `X.Y.Z` with
the target version throughout. Do the steps in order; the gate must be green
before the version bump and again at publish (`prepublishOnly` re-runs it).

## Versioning

Pre-1.0 SemVer: **minor** (`0.3.x → 0.4.0`) for a new feature, **patch**
(`0.4.0 → 0.4.1`) for a fix. Reserve a major-style break (or the eventual
`1.0.0`) for a change to the on-wire formats — the proof descriptor, shard tree,
or MASL manifest — or a removed/renamed public option. Widening an option
(e.g. making a field optional) is not breaking.

## What holds the version

- `package.json` `"version"` is the source of truth; `package-lock.json` mirrors
  it (two spots). `npm version` updates both.
- There is **no** version constant in `src/` or `tools/` — don't grep for one.
- `dist/` is **gitignored** and rebuilt by `prepublishOnly`; the release commit
  never contains built files, and `npm publish` bundles a fresh `dist/`.
- The examples and README load the browser bundle from a CDN by version — those
  pins are separate from `package.json` (see _CDN pins_ below).

## 1. Pre-flight

From a clean tree on `main`:

```
git status                 # only the intended release changes; nothing stray
npm test && npm run typecheck && npm run build
```

Do **not** stage the untracked working docs. `SPEC.md` is the only committed
spec.

## 2. CHANGELOG

Add a top entry to `CHANGELOG.md` (Keep a Changelog format, no dates — npm and
the git tags hold the timeline). A `## [X.Y.Z] — Short title` heading with
`Added` / `Changed` / `Fixed` / `Notes` sections, newest first. The title names
the release's headline in a few words (e.g. `Routing hints`) and becomes the
GitHub Release title via the §6 extraction command. Reuse the same text as the
annotated tag message and the GitHub Release body.

```markdown
## [X.Y.Z] — Short title

### Added

- …

### Changed

- …

### Notes

- Breaking changes, if any (none for a normal minor/patch — formats unchanged).

[X.Y.Z]: https://github.com/guillaumemichel/veritiles/releases/tag/vX.Y.Z
```

## 3. CDN pins (README + examples)

The browser bundle is loaded by a CDN `<script src>` in the README and each
example. Find every pin:

```
grep -rn "unpkg.com/veritiles@" README.md examples/
```

Use a **minor range**, `veritiles@MAJOR.MINOR` (e.g. `@0.4`), not an exact
`@X.Y.Z`:

- Patches flow automatically, so the pins never drift stale between patch
  releases (an exact pin once left the examples on `@0.3.0` after `0.3.1`
  shipped — the failure this avoids).
- Only touch the pins on a **minor** bump (`@0.4` → `@0.5`), which is when the
  examples may need editing for API changes anyway. A patch release changes no
  pins.

Do **not** touch the `// NOTE: … predates veritiles X's proof format …` comments
— they are historical notes about the hosted demo package, not version pins.

Adjacent guidance (not release steps): keep `npm install veritiles` as the
canonical install path (a bundler + lockfile pins it correctly). For a
trust-critical `<script>` include, prefer pin + SRI (`integrity=…`,
`crossorigin`); the illustrative examples stay on the plain minor-range pin.

## 4. Bump, commit, tag

Two equivalent ways — pick one.

**A. `npm version` (bumps `package.json` + lock, commits, tags):**

```
# stage the changelog + any pin edits first
git add CHANGELOG.md README.md examples/
git commit -m "docs: vX.Y.Z changelog and CDN pins"

npm version <patch|minor> -m "chore: release v%s"   # bumps, commits, tags vX.Y.Z
```

**B. Manual (matches the shape of prior release commits):**

```
# edit package.json + package-lock.json version fields to X.Y.Z,
# plus CHANGELOG.md and any pin edits
git add -A            # confirm `git status` shows only release files
git commit -m "chore: release vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"          # tag body = the CHANGELOG entry
```

Prior releases used a minimal `chore: release vX.Y.Z` commit touching only the
version files; keeping the changelog/pin edits in a separate commit matches that
shape.

## 5. Push — CI publishes

Publishing is automated: `.github/workflows/release.yml` fires on the `vX.Y.Z`
tag push, checks the tag against `package.json`, re-runs the gate via
`prepublishOnly`, publishes to npm with trusted publishing (OIDC — no tokens,
provenance attestations included), and creates a **draft** GitHub Release.

```
git push origin main --follow-tags
```

Do **not** run `npm publish` locally: a second publish of the same version
fails, and a local publish carries no provenance. Local publish is the
last-resort fallback when the workflow is unavailable — expect the workflow run
for that tag to then fail red on the duplicate.

## 6. Verify

- The Release workflow run for `vX.Y.Z` is green
- `npm view veritiles version` → `X.Y.Z`
- `npm view veritiles dist-tags.latest` → `X.Y.Z`
- `https://unpkg.com/veritiles@X.Y.Z/dist/veritiles.js` resolves (unpkg may lag a
  minute), and the minor-range URL `…/veritiles@MAJOR.MINOR/…` redirects to it
- CI drafted the GitHub Release with auto-generated notes; replace the body with
  the changelog entry and publish it. Extract the entry unwrapped (GitHub
  renders every newline as a line break, so the changelog's ~80-column wrapping
  must be joined):

  ```
  v=X.Y.Z
  awk "/^## \[/{f=0} /^## \[$v\]/{f=1} f" CHANGELOG.md | awk 'function p(){if(b!=""){print b;b=""}} /^## /{sub(/^## \[/,"v");sub(/\]/,"");print;next} /^$/{p();print;next} /^[#-]/{p();b=$0;next} {sub(/^ +/,"");b=(b==""?$0:b" "$0)} END{p()}'
  ```

  The first output line (`vX.Y.Z — Title`) is the Release title; everything
  after the blank line is the body. Pipe to `wl-copy` (or `xclip -selection
  clipboard`) to paste into the web form, or drop the first two lines and pipe
  into `gh release edit vX.Y.Z --notes-file - --draft=false`
- Smoke-test an example against the new bundle if this release changed the client
  API (e.g. `examples/hints.html` after the routing-hints release)

## Checklist

- [ ] Gate green (`npm test && npm run typecheck && npm run build`)
- [ ] `CHANGELOG.md` has the `[X.Y.Z]` entry
- [ ] CDN pins are the current minor range (only changed on a minor bump)
- [ ] `package.json` + `package-lock.json` at `X.Y.Z`
- [ ] Working docs (`PLAN-*`, `SPEC-*`, `RELEASE-v*`) not committed
- [ ] `chore: release vX.Y.Z` commit + `vX.Y.Z` tag
- [ ] `git push origin main --follow-tags`
- [ ] Release workflow green — CI published to npm (gate re-ran via `prepublishOnly`)
- [ ] unpkg serves `@X.Y.Z`; draft GitHub Release body swapped for the changelog
      entry and published
