#import "RevealButtonCell.h"
#import "JobProxy.h"
@import QuartzCore;

/// The reveal button is only hinted at until the pointer is over the row.
static const CGFloat kRevealButtonFadedAlpha = 0.3;

@implementation IOTableCellView

- (void)setObjectValue:(id)objectValue {
    [super setObjectValue:objectValue];

    if ([objectValue isKindOfClass:[JobProxy class]]) {
        self.toolTip = [(JobProxy *)objectValue statusText];
    } else {
        self.toolTip = nil;
    }
}

@end

static NSString *const kIOSpinAnimationKey = @"IOProgressSpin";
static const char *kIOSpinContext = "iospin";

@implementation IOStatusCellView {
    CALayer *spinLayer;
}

// Observing through objectValue means KVO re-registers itself whenever the row's
// job changes, so the spin follows the status without per-row bookkeeping.
- (void)awakeFromNib {
    [super awakeFromNib];
    // The spinning copy of the icon sits in the middle of the image view's box,
    // so the static icon has to be centred too or it jumps as the spin starts.
    self.imageView.imageAlignment = NSImageAlignCenter;
    [self addObserver:self
           forKeyPath:@"objectValue.statusImageName"
              options:NSKeyValueObservingOptionInitial
              context:(void *)kIOSpinContext];
}

- (void)dealloc {
    [self removeObserver:self forKeyPath:@"objectValue.statusImageName" context:(void *)kIOSpinContext];
}

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object
                        change:(NSDictionary *)change context:(void *)context {
    if (context == (void *)kIOSpinContext) {
        [self updateSpinState];
    }
}

- (void)updateSpinState {
    NSString *name = nil;
    id value = self.objectValue;
    if ([value isKindOfClass:[JobProxy class]]) {
        name = [(JobProxy *)value statusImageName];
    }

    if ([name isEqualToString:@"progress"]) {
        [self startSpinning];
    } else {
        [self stopSpinning];
    }
}

// An NSView's backing layer is anchored at its corner, and AppKit puts the anchor
// back there on every layout pass, so rotating the image view's own layer swings
// the icon around that corner instead of spinning it. The animation gets a layer
// of its own, anchored in the middle, carrying the icon as its contents.
- (void)startSpinning {
    if (spinLayer) {
        return;
    }

    self.wantsLayer = YES;
    CALayer *host = self.layer;
    if (!host) {
        return;
    }

    spinLayer = [CALayer layer];
    spinLayer.anchorPoint = CGPointMake(0.5, 0.5);
    spinLayer.contentsGravity = kCAGravityResizeAspect;
    spinLayer.contentsScale = host.contentsScale;
    [host addSublayer:spinLayer];

    CABasicAnimation *spin = [CABasicAnimation animationWithKeyPath:@"transform.rotation.z"];
    spin.fromValue = @(0.0);
    spin.toValue = @(-2.0 * M_PI);
    spin.duration = 1.0;
    spin.repeatCount = HUGE_VALF;
    spin.removedOnCompletion = NO;
    [spinLayer addAnimation:spin forKey:kIOSpinAnimationKey];

    [self updateSpinLayerGeometry];
}

- (void)stopSpinning {
    if (!spinLayer) {
        return;
    }

    [spinLayer removeAnimationForKey:kIOSpinAnimationKey];
    [spinLayer removeFromSuperlayer];
    spinLayer = nil;
    self.imageView.hidden = NO;
}

// The icon belongs to the image view, which the row's binding may not have filled
// in yet, so this runs again on every layout pass. The image view stays visible
// until there is something to spin in its place.
- (void)updateSpinLayerGeometry {
    NSImageView *icon = self.imageView;
    NSImage *image = icon.image;
    NSSize size = image.size;
    if (!spinLayer || !image || size.width <= 0.0 || size.height <= 0.0) {
        return;
    }

    NSRect box = [self convertRect:icon.bounds fromView:icon];
    // NSImageScaleProportionallyDown: shrink to fit the box, never enlarge.
    CGFloat scale = MIN(1.0, MIN(box.size.width / size.width, box.size.height / size.height));

    spinLayer.contents = image;
    spinLayer.bounds = CGRectMake(0.0, 0.0, round(size.width * scale), round(size.height * scale));
    spinLayer.position = CGPointMake(NSMidX(box), NSMidY(box));
    icon.hidden = YES;
}

- (void)layout {
    [super layout];
    [self updateSpinLayerGeometry];
}

@end

@implementation FileNameCellView {
    NSTrackingArea *trackingArea;
}

- (void)awakeFromNib {
    [super awakeFromNib];
    self.revealButton.alphaValue = kRevealButtonFadedAlpha;
}

- (void)updateTrackingAreas {
    [super updateTrackingAreas];

    if (trackingArea) {
        [self removeTrackingArea:trackingArea];
    }

    trackingArea = [[NSTrackingArea alloc] initWithRect:NSZeroRect
                                                options:NSTrackingMouseEnteredAndExited | NSTrackingActiveInKeyWindow | NSTrackingInVisibleRect
                                                  owner:self
                                               userInfo:nil];
    [self addTrackingArea:trackingArea];
}

- (void)mouseEntered:(NSEvent *)event {
    self.revealButton.alphaValue = 1.0;
}

- (void)mouseExited:(NSEvent *)event {
    self.revealButton.alphaValue = kRevealButtonFadedAlpha;
}

- (NSURL *)rowFilePath {
    id value = self.objectValue;
    if ([value isKindOfClass:[JobProxy class]]) {
        return [(JobProxy *)value filePath];
    }
    return nil;
}

- (void)setObjectValue:(id)objectValue {
    [super setObjectValue:objectValue];

    // A row that is reused keeps whatever alpha the previous row left behind.
    self.revealButton.alphaValue = kRevealButtonFadedAlpha;
    self.revealButton.toolTip = [self rowFilePath].path;
}

- (IBAction)revealInFinder:(id)sender {
    NSURL *path = [self rowFilePath];
    if (path) {
        [[NSWorkspace sharedWorkspace] activateFileViewerSelectingURLs:@[ path ]];
    }
}

@end
