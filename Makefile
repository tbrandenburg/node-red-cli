.PHONY: install install-global format lint test audit audit-upstream ci clean release

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

# Probes whether a newer, not-yet-adopted node-red release resolves our
# currently known vulnerabilities, without touching this repo's pinned
# dependency. 'make audit' alone can never detect this: it only re-checks
# the version we already have locked in package-lock.json. This installs
# the latest node-red into a scratch directory and re-runs npm audit
# there. It intentionally fails (a call to action, not a bug) when that
# latest version is clean, so a scheduled CI run surfaces "time to bump
# node-red" instead of silently re-reporting the same known issues forever.
audit-upstream:
	@current=$$(node -p "require('./package.json').dependencies['node-red']"); \
	latest=$$(npm view node-red version); \
	if [ "$$current" = "$$latest" ]; then \
		echo "node-red is already at the latest published version ($$latest); nothing newer to check."; \
		exit 0; \
	fi; \
	echo "Currently pinned: node-red@$$current -- Latest published: node-red@$$latest"; \
	scratch=$$(mktemp -d); \
	(cd "$$scratch" && npm init -y >/dev/null && npm install "node-red@$$latest" --no-audit --no-fund >/dev/null 2>&1); \
	if (cd "$$scratch" && npm audit); then \
		echo "node-red@$$latest resolves all currently known vulnerabilities -- bump the dependency."; \
		rm -rf "$$scratch"; \
		exit 1; \
	else \
		echo "node-red@$$latest still carries known vulnerabilities; nothing actionable yet."; \
		rm -rf "$$scratch"; \
	fi

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
