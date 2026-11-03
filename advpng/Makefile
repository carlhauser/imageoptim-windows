ARCHIVE=advancecomp_1.15.orig.tar.gz
ARCHIVE_SHA256=0d235c78224d450666bdd852a301159d53b9570e9cd28f015e222797ba4d5fe1

build: all

all: repng.cc

repng.cc: $(ARCHIVE)
	tar xzf $(ARCHIVE) --strip-components=1

$(ARCHIVE):
	../scripts/fetch-verify https://snapshot.debian.org/archive/debian/20120101T000000Z/pool/main/a/advancecomp/$(ARCHIVE) $(ARCHIVE) $(ARCHIVE_SHA256)

clean:
	-rm -f $(ARCHIVE)

install:

.PHONY: build all install clean
