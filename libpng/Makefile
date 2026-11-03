# libpng is fetched straight from the project's own release rather than being
# carved out of an optipng tarball, so it can be kept current. Its sources are
# compiled by the "static" target in libpng.xcodeproj together with ../zlib.

VERSION=1.6.59
ARCHIVE=libpng-$(VERSION).tar.gz
ARCHIVE_SHA256=86a3e4b501f7f50e392c4e456ea158893e9a595b1c63eb88c7bb9f6cf8772dad

build: all

all: png.h

png.h: $(ARCHIVE)
	tar xzf $(ARCHIVE) --strip-components=1 --exclude=Makefile libpng-$(VERSION)
	# configure normally generates pnglibconf.h; the release ships a prebuilt copy
	cp scripts/pnglibconf.h.prebuilt pnglibconf.h
	# ImageOptim never reads MNG, and pngcrush.patch strips pngcrush's MNG support.
	# libpng's own MNG features macro is what gates pngcrush's PNGCRUSH_LOCO blocks,
	# whose 'new_mng' declaration that patch removes, so keep the feature off.
	sed -i.bak '/#define PNG_MNG_FEATURES_SUPPORTED/d' pnglibconf.h && rm pnglibconf.h.bak
	# the static target compiles only libpng's 15 core sources, not its arm/ NEON
	# helpers, so turn the NEON path off instead of linking against absent symbols
	printf '\n/* ImageOptim: arm/ NEON sources are not part of the static target */\n#define PNG_ARM_NEON_OPT 0\n' >> pnglibconf.h

$(ARCHIVE):
	../scripts/fetch-verify https://downloads.sourceforge.net/project/libpng/libpng16/$(VERSION)/$(ARCHIVE) $(ARCHIVE) $(ARCHIVE_SHA256)

clean:
	-rm -f *.c *.h $(ARCHIVE)

install:

.PHONY: build all install clean
