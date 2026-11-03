
# zlib is not built here! Its sources are compiled by the libpng "static" target,
# which is what pngcrush, advpng, guetzli and the app framework all link against.
#
# Pinned to the immutable GitHub release URL rather than zlib.net, which only
# serves the current release and starts returning 404 on the next one.

VERSION=1.3.2
ARCHIVE=zlib-$(VERSION).tar.gz
ARCHIVE_SHA256=bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16

build: all

all: zlib.h

zlib.h: $(ARCHIVE)
	tar xzf $(ARCHIVE) --strip-components=1 --exclude=Makefile zlib-$(VERSION)

$(ARCHIVE):
	../scripts/fetch-verify https://github.com/madler/zlib/releases/download/v$(VERSION)/$(ARCHIVE) $(ARCHIVE) $(ARCHIVE_SHA256)

clean:
	-rm -f $(ARCHIVE)

install:

.PHONY: build all install clean
