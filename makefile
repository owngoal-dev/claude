SHELL := /bin/bash
ROOT_DIR := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))

include $(ROOT_DIR)/configuration/upstream.env

VERSION := $(strip $(shell cat "$(ROOT_DIR)/configuration/version.txt"))
PACKAGE_ID ?= wiki.qaq.claude
BUILD_DIR := $(ROOT_DIR)/build
PKG_DIR := $(BUILD_DIR)/Packages
PAYLOAD_DIR := $(BUILD_DIR)/payload

PACKAGE_FLAVOR ?= roothide
ifeq ($(PACKAGE_FLAVOR),roothide)
PACKAGE_PREFIX :=
PACKAGE_ARCH := iphoneos-arm64e
else ifeq ($(PACKAGE_FLAVOR),rootless)
PACKAGE_PREFIX := /var/jb
PACKAGE_ARCH := iphoneos-arm64
else
$(error PACKAGE_FLAVOR must be roothide or rootless)
endif

DEB := $(PKG_DIR)/$(PACKAGE_ID)_$(VERSION)_$(PACKAGE_ARCH).deb

.PHONY: all check fetch build package deb debs deb-rootless deb-roothide checksums clean print-version

all: debs

print-version:
	@echo "$(VERSION)"

check:
	@python3 "$(ROOT_DIR)/scripts/check-launcher.py" "$(ROOT_DIR)/packaging/claude.launcher.sh"
	@for script in scripts/*.sh; do bash -n "$$script" || exit 1; done
	@node --check scripts/patch-binary.mjs
	@python3 -m json.tool docs/depiction.json >/dev/null
	@python3 scripts/test-follow-upstream.py
	@plutil -lint packaging/claude.entitlements
	@version="$(VERSION)"; [[ "$$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9]+)?$$ && "$${version%%-*}" == "$(UPSTREAM_VERSION)" ]]
	@[[ "$(MIN_IOS)" =~ ^[0-9]+\.[0-9]+$$ ]]
	@./scripts/release-notes.sh "v$(VERSION)" >/dev/null
	@echo ok

fetch:
	@./scripts/fetch-upstream.sh

build: fetch
	@./scripts/build-ios.sh

package:
	@mkdir -p "$(PKG_DIR)"
	@PACKAGE_ID="$(PACKAGE_ID)" ./scripts/package-deb.sh \
		"$(PAYLOAD_DIR)" "$(DEB)" "$(VERSION)" "$(PACKAGE_ARCH)" "$(PACKAGE_PREFIX)"

deb: build package

deb-rootless:
	@$(MAKE) --no-print-directory PACKAGE_FLAVOR=rootless deb

deb-roothide:
	@$(MAKE) --no-print-directory PACKAGE_FLAVOR=roothide deb

debs: build
	@$(MAKE) --no-print-directory PACKAGE_FLAVOR=roothide package
	@$(MAKE) --no-print-directory PACKAGE_FLAVOR=rootless package
	@$(MAKE) --no-print-directory checksums

checksums:
	@cd "$(PKG_DIR)" && shasum -a 256 \
		"$(PACKAGE_ID)_$(VERSION)_iphoneos-arm64.deb" \
		"$(PACKAGE_ID)_$(VERSION)_iphoneos-arm64e.deb" | tee SHA256SUMS

clean:
	rm -rf "$(BUILD_DIR)"
