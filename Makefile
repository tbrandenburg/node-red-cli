.PHONY: install format lint test ci clean

install:
	npm install
	git config core.hooksPath .githooks

format:
	npx prettier --check .

lint:
	npx eslint .

test:
	npm test

ci: format lint test

clean:
	rm -rf node_modules
