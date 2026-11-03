//
//  CeilFormatter.m
//
//  Created by porneL on 30.wrz.07.
//

#import "Transformers.h"

@implementation CeilFormatter

+ (Class)transformedValueClass {
    return [NSNumber class];
}

- (id)transformedValue:(id)value {
    double v = 1.0;
    if ([value respondsToSelector:@selector(doubleValue)]) {
        v = MAX(1.0F, ceil([value doubleValue]));
    }
    return @(v);
}
@end

@implementation DisabledColor

+ (Class)transformedValueClass {
    return [NSColor class];
}

- (id)transformedValue:(id)value {
    if ([value respondsToSelector:@selector(boolValue)] && ![value boolValue]) {
        return [NSColor disabledControlTextColor];
    }
    return [NSColor textColor];
}
@end

static NSMutableDictionary *imageCache;

/// SF Symbol equivalent of each bundled status glyph, tinted to match its meaning.
/// Vector symbols track the system font weight and appearance, which the fixed-size
/// PNGs cannot. Pre-Big Sur falls back to those PNGs.
static NSImage *statusImageNamed(NSString *name) {
    if (@available(macOS 11.0, *)) {
        NSString *symbolName = nil;
        NSColor *tint = nil;

        if ([name isEqualToString:@"wait"]) {
            symbolName = @"clock";
            tint = [NSColor secondaryLabelColor];
        } else if ([name isEqualToString:@"progress"]) {
            symbolName = @"arrow.triangle.2.circlepath";
            tint = [NSColor controlAccentColor];
        } else if ([name isEqualToString:@"ok"]) {
            symbolName = @"checkmark.circle.fill";
            tint = [NSColor systemGreenColor];
        } else if ([name isEqualToString:@"err"]) {
            symbolName = @"exclamationmark.triangle.fill";
            tint = [NSColor systemRedColor];
        } else if ([name isEqualToString:@"noopt"]) {
            symbolName = @"minus.circle";
            tint = [NSColor secondaryLabelColor];
        }

        if (symbolName) {
            NSImage *symbol = [NSImage imageWithSystemSymbolName:symbolName accessibilityDescription:name];
            if (symbol) {
                if (@available(macOS 12.0, *)) {
                    NSImageSymbolConfiguration *sized =
                        [NSImageSymbolConfiguration configurationWithPointSize:13 weight:NSFontWeightRegular];
                    NSImageSymbolConfiguration *coloured =
                        [NSImageSymbolConfiguration configurationWithPaletteColors:@[ tint ]];
                    NSImage *configured =
                        [symbol imageWithSymbolConfiguration:
                            [sized configurationByApplyingConfiguration:coloured]];
                    if (configured) {
                        return configured;
                    }
                }
                return symbol;
            }
        }
    }
    return [NSImage imageNamed:name];
}

@implementation IOStatusImage

+ (Class)transformedValueClass {
    return [NSImage class];
}

- (id)transformedValue:(id)value {
    if (!value) {
        value = @"err";
    }
    if (!imageCache) {
        imageCache = [NSMutableDictionary new];
    }
    NSImage *img = imageCache[value];
    if (!img) {
        imageCache[value] = img = statusImageNamed(value);
    }
    return img;
}
@end
