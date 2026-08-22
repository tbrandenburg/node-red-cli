.PHONY: install install-global format lint test ci clean

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
