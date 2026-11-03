HELPINDEXES=$(addsuffix Help.helpindex, $(wildcard *.lproj/Help/))
PNGOUT_ZIP=pngout-20230322-mac.zip
PNGOUT_SHA256=2e3eb79345206040ae3a0d0d0ecfe9ad01d92fe5002b8a1676a65632a56840e1
SUBMODULES=../Sparkle/Sparkle ../svgcleaner/src

build: all

all: $(SUBMODULES) pngout helpindexes

$(SUBMODULES): ../.gitmodules
	../scripts/fetch-submodule $(shell dirname $@) && touch $@

$(PNGOUT_ZIP):
	../scripts/fetch-verify https://www.jonof.id.au/files/kenutils/$(PNGOUT_ZIP) $(PNGOUT_ZIP) $(PNGOUT_SHA256)

pngout: $(PNGOUT_ZIP)
	unzip -p $(PNGOUT_ZIP) pngout-20230322-mac/pngout > pngout
	chmod a+rx pngout
	# use a Developer ID when the signing identity exists, otherwise ad-hoc sign so
	# the downloaded binary still runs on Apple Silicon for local builds
	codesign -s "Developer ID" ./pngout --force 2>/dev/null || codesign -s - ./pngout --force

clean:
	-rm -rf pngout $(PNGOUT_ZIP)

install:

helpindexes:: $(HELPINDEXES)

%/Help.helpindex: %/index.html %/prefs.html
	./makehelp.sh $(patsubst %.lproj/Help/Help.helpindex,%,$@)

.PHONY: build all install clean
