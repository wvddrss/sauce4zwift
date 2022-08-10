default: build

PACKAGES := node_modules/.build
BUILD := .build

ifeq ($(OS),Windows_NT)
  WINBLOWS := true
  SHELL := powershell.exe
  .SHELLFLAGS := -C
endif

MODS := $(CURDIR)/node_modules
NPATH := $(MODS)/.bin
TOOLPATH := $(CURDIR)/tools/bin
ifndef WINBLOWS
  PAGES_SRC := $(shell find pages -type f)
endif

$(PACKAGES): package.json
	npm install
	echo "" > $@

$(BUILD): $(PAGES_SRC) $(PACKAGES) sass deps Makefile .git/index
	echo "" > $@

build: $(BUILD)

run: $(BUILD)
	npm start

run-debug: $(BUILD)
	npm run start-debug

run-debug-brk: $(BUILD)
	npm run start-debug-brk

lint:
	$(NPATH)/eslint --ext .mjs --config .eslintrc.modules.json src shared pages/src
	$(NPATH)/eslint src

unpacked: $(BUILD)
ifndef WINBLOWS
	SKIP_NOTARIZE=1 npm run unpacked
else
	npm run unpacked
endif

packed: $(BUILD)
ifndef WINBLOWS
	SKIP_NOTARIZE=1 npm run build
else
	npm run build
endif

publish: $(BUILD)
	npm run publish

deps:
	cp node_modules/echarts/dist/echarts.esm.js pages/deps/src/echarts.mjs
	cp node_modules/world_countries_lists/data/countries/_combined/world.json pages/deps/src/countries.json
ifndef WINBLOWS
	mkdir -p pages/deps/flags
else
	mkdir -f pages/deps/flags
endif
	cp -r node_modules/world_countries_lists/data/flags/64x64/*.png pages/deps/flags/
	cp node_modules/zwift-data/lib/esm/routes.js shared/deps/routes.mjs
	cp node_modules/zwift-data/lib/esm/segments.js shared/deps/segments.mjs

sass:
	$(NPATH)/sass pages/scss:pages/css

sass-watch:
	$(NPATH)/sass pages/scss:pages/css --watch

lint-watch:
ifndef WINBLOWS
	while true ; do \
		$(MAKE) lint; \
		sleep 5; \
	done
else
	@echo Unsupported on winblows
endif

clean:
ifndef WINBLOWS
	rm -rf pages/deps/src/*
	rm -rf pages/deps/flags
	rm -rf shared/deps/*
	rm -f $(BUILD)
else
	-rm -r -fo -ErrorAction SilentlyContinue pages/deps/src/*
	-rm -r -fo -ErrorAction SilentlyContinue pages/deps/flags
	-rm -r -fo -ErrorAction SilentlyContinue shared/deps/*
	-rm -fo -ErrorAction SilentlyContinue $(BUILD)
endif

.PHONY: build pack publish lint sass deps clean
