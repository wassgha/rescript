.PHONY: build sign clean

# SpeechAnalyzer requires macOS 26 + a signed binary. `swift run` skips
# signing and will crash on first analyzer touch — always go through `make`.

BINARY ?= .build/release/rescript-speechanalyzer
DEST ?= ../../resources/bin/rescript-speechanalyzer

build:
	@uname -s | grep -q Darwin || (echo "error: SpeechAnalyzer helper only builds on macOS" >&2; exit 1)
	swift build -c release \
		-Xlinker -sectcreate -Xlinker __TEXT \
		-Xlinker __info_plist -Xlinker Resources/Info.plist
	$(MAKE) sign
	mkdir -p "$(dir $(DEST))"
	cp "$(BINARY)" "$(DEST)"
	@echo "installed $(DEST)"

sign:
	codesign --sign - --options runtime \
		--entitlements Resources/entitlements.plist \
		--force "$(BINARY)"

clean:
	swift package clean
	rm -rf .build
	rm -f "$(DEST)"
