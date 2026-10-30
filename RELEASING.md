# Releasing

The repeatable runbook for cutting a release of the packages: `anymirror`,
`veritiles` and, when its contract changed, `@anymirror/router`. Replace
`X.Y.Z` with the target version throughout. Do the steps in order; the gate
must be green before the version bump, and the release workflow re-runs it
before it publishes.

## Versioning

Pre-1.0 SemVer: **minor** (`0.3.x → 0.4.0`) for a new feature, **patch**
(`0.4.0 → 0.4.1`) for a fix. Reserve a major-style break (or the eventual
`1.0.0`) for a change to the on-wire formats — the proof descriptor, shard tree,
or MASL manifest — or a removed/renamed public option. Widening an option
(e.g. making a field optional) is not breaking.

`anymirror` and `veritiles` share one version line and are released together:
veritiles pins anymirror at its own version. `@anymirror/router` has a
version of its own and moves only when the contract changes, so routers
written for it keep working across releases; most releases leave it alone.

## What holds the version

- The version line lives in `packages/anymirror/package.json` and
  `packages/veritiles/package.json`, plus veritiles' dependency on anymirror;
  `npm run version:line -- X.Y.Z` sets all three, and `npm install` then
  updates `package-lock.json`. The tag must name the line's version.
- The contract's version is `packages/router/package.json`'s, with the range
  anymirror depends on in `packages/anymirror/package.json`; both change by
  hand, and only with the contract.
- There is **no** version constant in any `src/` or `tools/` — don't grep for
  one.
- Every `dist/` is **gitignored** and rebuilt by its package's `prepack`; the
  release commit never contains built files, and `npm publish` packs a fresh
  `dist/`.
- The examples and README load the browser bundle from a CDN by version — those
  pins are separate from `package.json` (see _CDN pins_ below).

## 1. Pre-flight

From a clean tree on `main`:

```
git status                 # only the intended release changes; nothing stray
npm test && npm run typecheck && npm run build && npm run test:packages
cargo build --release --manifest-path packer/Cargo.toml && npm run test:diff
```

`npm run test:packages` installs the packed tarballs in an empty project and
checks what each entry point exports and that their types resolve.
`npm run test:diff` checks the Rust packer against `tools/pack.ts` byte for
byte; `npm test` runs neither.

Do **not** stage the untracked working docs. `SPEC.md` is the only committed
spec.

## 2. CHANGELOG

Add a top entry to `CHANGELOG.md` (Keep a Changelog format, no dates — npm and
the git tags hold the timeline). A `## [X.Y.Z] — Short title` heading with
`Added` / `Changed` / `Fixed` / `Notes` sections, newest first. The title names
the release's headline in a few words (e.g. `Routing hints`) and becomes the
GitHub Release title via the §6 extraction command. Reuse the same text as the
annotated tag message and the GitHub Release body.

Link a `SPEC.md` section at the release tag, as in the template: the link keeps
showing the spec the entry describes after sections are renumbered, and an
absolute URL works in the tag and Release bodies too. A link in `[Unreleased]`
names the expected next tag; check it once the version is settled.

```markdown
## [X.Y.Z] — Short title

### Added

- **Feature** ([`SPEC.md` §N](https://github.com/anymirror-dev/anymirror/blob/vX.Y.Z/SPEC.md#n-section-name)): …

### Changed

- …

### Notes

- Breaking changes, if any (none for a normal minor/patch — formats unchanged).

[X.Y.Z]: https://github.com/anymirror-dev/anymirror/releases/tag/vX.Y.Z
```

## 3. CDN pins (README + examples)

The browser bundle is loaded by a CDN `<script src>` in the README and each
example. Find every pin:

```
grep -rn "unpkg.com/veritiles@" packages/veritiles/README.md packages/veritiles/examples/
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

```
npm run version:line -- X.Y.Z && npm install   # anymirror, veritiles and its pin
# only if the contract changed: packages/router/package.json's version, and
# anymirror's range for it in packages/anymirror/package.json
git add -A            # confirm `git status` shows only release files
git commit -m "chore: release vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"          # tag body = the CHANGELOG entry
```

Prior releases kept the changelog and pin edits in a commit of their own,
before a `chore: release vX.Y.Z` commit touching only the version files;
either shape is fine.

## 5. Push — CI publishes

Publishing is automated: `.github/workflows/release.yml` fires on the
`vX.Y.Z` tag push, checks the tag against anymirror's version, re-runs the
gate, then publishes every package whose version npm does not have yet, the
contract first, with trusted publishing (OIDC — no tokens, provenance
attestations included). A prerelease version goes out under the `next`
dist-tag. It ends by creating a **draft** GitHub Release.

```
git push origin main --follow-tags
```

Do **not** run `npm publish` locally: a second publish of the same version
fails, and a local publish carries no provenance. Two exceptions:

- **A new package** must exist on npm before its trusted publisher can be
  set. Publish its first version by hand, as a real prerelease
  (`npm run build && npm publish -w <name> --tag next`), then on npmjs.com set
  its trusted publisher to owner `anymirror-dev`, repository `anymirror`,
  workflow `release.yml`.
- **The last resort** when the workflow is unavailable; expect the workflow
  run for that tag to then fail red on the duplicate.

## 6. Verify

- The Release workflow run for `vX.Y.Z` is green
- `npm view anymirror version` and `npm view veritiles version` → `X.Y.Z`,
  and so does `dist-tags.latest` for each
- if the contract changed, `npm view @anymirror/router version` → its new
  version
- `https://unpkg.com/veritiles@X.Y.Z/dist/veritiles.js` resolves (unpkg may lag a
  minute), and the minor-range URL `…/veritiles@MAJOR.MINOR/…` redirects to it
- CI drafted the GitHub Release with GitHub's generated notes. Replace its body
  with, in order: a `# vX.Y.Z — Title` heading; 3–5 one-line highlights from
  the changelog entry, each `- <emoji> **Title.** One sentence.`, plus a
  `- ⚠️ **Breaking.** …` line when the release breaks anything; the entry's
  Added/Changed/Fixed/Notes collapsed under `<details>`; then GitHub's
  generated "What's Changed", "New Contributors" and "Full Changelog" lines.
  The title stays `vX.Y.Z`. Write the highlights to `/tmp/highlights.md`, then:

  ```
  v=X.Y.Z prev=A.B.C   # this release and the one before it
  entry=$(awk "/^## \[/{f=0} /^## \[$v\]/{f=1} f" CHANGELOG.md | awk 'function p(){if(b!=""){print b;b=""}} /^## /{sub(/^## \[/,"v");sub(/\]/,"");print;next} /^$/{p();print;next} /^[#-]/{p();b=$0;next} {sub(/^ +/,"");b=(b==""?$0:b" "$0)} END{p()}')
  {
    printf '# %s\n\n' "$(printf '%s\n' "$entry" | head -1)"
    cat /tmp/highlights.md
    printf '\n<details>\n<summary>Detailed changes</summary>\n\n%s\n\n</details>\n\n' "$(printf '%s\n' "$entry" | sed -n '/^### /,$p')"
    gh api -X POST repos/anymirror-dev/anymirror/releases/generate-notes -f tag_name="v$v" -f previous_tag_name="v$prev" --jq .body
  } | gh release edit "v$v" --notes-file -
  ```

  The second `awk` joins the changelog's ~80-column wrapping, since GitHub
  renders every newline in a release body as a line break. `gh release edit`
  keeps the draft's tag; a raw API `PATCH` without `tag_name` detaches it.
  Review the draft on GitHub, then publish it.
- Smoke-test an example against the new bundle if this release changed the client
  API (e.g. `packages/veritiles/examples/hints.html` after the routing-hints
  release)

## Checklist

- [ ] Gate green (`npm test && npm run typecheck && npm run build && npm run test:packages`)
- [ ] Packer diff green (`cargo build --release --manifest-path packer/Cargo.toml && npm run test:diff`)
- [ ] `CHANGELOG.md` has the `[X.Y.Z]` entry
- [ ] CDN pins are the current minor range (only changed on a minor bump)
- [ ] `npm run version:line -- X.Y.Z && npm install`: anymirror, veritiles
      and veritiles' pin at `X.Y.Z`; the contract's version only if it changed
- [ ] Working docs (`PLAN-*`, `SPEC-*`, `RELEASE-v*`) not committed
- [ ] `chore: release vX.Y.Z` commit + `vX.Y.Z` tag
- [ ] `git push origin main --follow-tags`
- [ ] Release workflow green — CI published each new version to npm (the gate
      re-ran first)
- [ ] unpkg serves `@X.Y.Z`; draft GitHub Release body set to highlights, the
      collapsed changelog and the generated contributor notes, then published
