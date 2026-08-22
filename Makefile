.PHONY: install install-global format lint test audit ci clean release

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
release:
	@if [ -z "$(bump)" ]; then echo "usage: make release bump=patch|minor|major"; exit 1; fi
	@case "$(bump)" in patch|minor|major) ;; *) echo "invalid bump '$(bump)', expected patch, minor, or major"; exit 1;; esac
	@if [ -n "$$(git status --porcelain)" ]; then echo "working tree is not clean, aborting"; exit 1; fi
	$(MAKE) ci
	npm version $(bump) -m "chore: release v%s"
	git push && git push --tags
	gh release create "v$$(node -p "require('./package.json').version")" --generate-notes
