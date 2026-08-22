.PHONY: install install-global format lint test ci clean release

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

ci: format lint test

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
