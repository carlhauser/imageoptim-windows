VERSION=1.8.10
ARCHIVE=pngcrush-$(VERSION).tar.gz
ARCHIVE_SHA256=ed8dc4759d5067ebf53a2a5188eff1e8ad10262737cf50516cccf8c60d220b6d

build: all

all: pngcrush.c

$(ARCHIVE):
	../scripts/fetch-verify https://downloads.sourceforge.net/project/pmt/pngcrush/old-versions/1.8/$(VERSION)/pngcrush-$(VERSION).tar.gz $(ARCHIVE) $(ARCHIVE_SHA256)

tmp/pngcrush.c: pngcrush.patch $(ARCHIVE)
	test -d tmp || mkdir -p tmp
	tar xzf $(ARCHIVE) -C tmp --strip-components=1 --exclude=Makefile

pngcrush.c: tmp/pngcrush.c
	( cd tmp; patch --forward -p1 < ../pngcrush.patch )
	-rm tmp/png.h tmp/pngconf.h 2>/dev/null
	cp tmp/*.[ch] ./
	touch pngcrush.c

clean:
	-rm -rf tmp *.c *.h $(ARCHIVE) patched

install:

.PHONY: all build clean
