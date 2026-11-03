all: ./build/svgo.js

./build/svgo.js: ./node_modules/.bin/webpack index.js webpack.config.js
	./node_modules/.bin/webpack

# npm ci installs exactly what package-lock.json pins and verifies every
# package against its recorded sha512, instead of re-resolving ^ ranges
# against the registry on every build
./node_modules/.bin/webpack: package-lock.json package.json
	npm ci && touch -c ./node_modules/.bin/webpack

clean:
	-rm -rf build node_modules

.PHONY: clean
