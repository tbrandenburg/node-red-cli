.PHONY: install install-global format lint test audit ci clean release publish

install:
	npm install
	git config core.hooksPath .githooks

install-global:
	npm install -g .

format:
	npx prettier --check .

lint:
	npx eslint .

test:
	npm test

# Fails when npm audit finds vulnerabilities. Intentionally not part of the
# push/merge gate (see ci below): several findings are currently unfixable
# transitive issues bundled inside node-red's own npm client (jsonata/tar/
# undici) and require an upstream node-red release. Run standalone or via
# .github/workflows/audit.yml to get a real, visible red signal without
# blocking pushes or merges on something we can't fix ourselves.
audit:
	npm audit

# audit is intentionally best-effort here (leading '-'): format/lint/test
# must pass to push or merge, but a failing audit must not block either.
ci: format lint test
	-$(MAKE) audit

clean:
	rm -rf node_modules

# Cuts a release: bumps the version, commits, tags, pushes, and creates a
# GitHub release. Usage: make release bump=patch|minor|major
#
# Pushes the branch + tag in one `--follow-tags` push instead of two
# separate pushes, and skips the pre-push hook (--no-verify) for that one
# push: `make ci` just ran, unchanged, a few lines above, so the hook
# re-running the identical suite a second (or, with two pushes, third)
# time is pure duplication, not an extra safety check. Every other push
# (by anyone, anywhere) still goes through the hook normally -- this
# bypass is scoped to this target only.
#
# Publishing the GitHub release triggers .github/workflows/publish.yml,
# which publishes via npm's OIDC "trusted publishing" (no token secret).
# Bootstrap sequence for a brand-new package:
#   1. make release bump=patch   (this target)
#   2. make publish              (first publish must be manual/interactive;
#                                  trusted publishing can't be configured
#                                  until the package exists on npmjs.com)
#   3. on npmjs.com: Packages -> node-red-cli -> Settings -> Trusted
#      publishing -> add GitHub Actions, pointing at this repo and
#      publish.yml
#   4. subsequent `make release` runs auto-publish via CI, no manual step
release:
	@if [ -z "$(bump)" ]; then echo "usage: make release bump=patch|minor|major"; exit 1; fi
	@case "$(bump)" in patch|minor|major) ;; *) echo "invalid bump '$(bump)', expected patch, minor, or major"; exit 1;; esac
	@if [ -n "$$(git status --porcelain)" ]; then echo "working tree is not clean, aborting"; exit 1; fi
	$(MAKE) ci
	npm version $(bump) -m "chore: release v%s"
	git push --no-verify --follow-tags
	gh release create "v$$(node -p "require('./package.json').version")" --generate-notes

# Manual/local npm publish. Required for the very first publish of a new
# package (see the bootstrap sequence above) since trusted publishing can
# only be configured once the package already exists on npmjs.com.
# Requires `npm login` (or an equivalent auth token) to already be set up;
# npm will prompt for your 2FA OTP interactively.
publish:
	npm publish
