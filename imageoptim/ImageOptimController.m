#import "ImageOptimController.h"
#import "FilesController.h"
#import "Backend/Job.h"
#import "JobProxy.h"
#import "File.h"
#import "Backend/Workers/Worker.h"
#import "PrefsController.h"
#import "MyTableView.h"
#import "SharedPrefs.h"
#include <mach/mach_host.h>
#include <mach/host_info.h>
#import <Quartz/Quartz.h>

@interface ImageOptimController ()
@property (strong) NSVisualEffectView *failureToast;
@property (weak) NSTextField *failureToastLabel;
@property (weak) NSImageView *failureToastIcon;
@property (weak) NSButton *failureToastClose;
@property (strong) NSTimer *failureToastTimer;
@property (assign) NSUInteger failureCount;
@end

@implementation ImageOptimController

extern int quitWhenDone;

static const char *kIMPreviewPanelContext = "preview";

@synthesize filesController;

- (void)applicationWillFinishLaunching:(NSNotification *)unused {
    if (quitWhenDone) {
        [NSApp hide:self];
    }

    NSMutableDictionary *defs = [NSMutableDictionary dictionaryWithContentsOfFile:[[NSBundle mainBundle] pathForResource:@"defaults" ofType:@"plist"]];

    NSUInteger maxTasks = [[NSProcessInfo processInfo] activeProcessorCount];

    defs[@"RunConcurrentFiles"] = @(maxTasks);
    defs[@"RunConcurrentDirscans"] = @((int)ceil((double)maxTasks / 3.9));

    // Use lighter defaults on slower machines
    if (maxTasks <= 4) {
        defs[@"PngOutEnabled"] = @(NO);
        if (maxTasks <= 2) {
            defs[@"PngCrush2Enabled"] = @(NO);
        }
    }

    NSUserDefaults *userDefaults = [NSUserDefaults standardUserDefaults];
    [userDefaults registerDefaults:defs];

    [self initStatusbarWithDefaults:userDefaults];

    IOSharedPrefsCopy(userDefaults);

    [filesController configureWithTableView:tableView];
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(observeNotification:) name:kJobQueueFinished object:filesController];

    NSArray *monospaceFontColumns = @[
        fileColumn,
        sizeColumn,
        originalSizeColumn,
        savingsColumn,
        bestToolColumn,
    ];
    for (NSTableColumn *column in monospaceFontColumns) {
        NSFont *font = [NSFont systemFontOfSize:13];
        if ([NSFont respondsToSelector:@selector(monospacedDigitSystemFontOfSize:weight:)]) {
            if (@available(macOS 10.11, *)) {
                font = [NSFont monospacedDigitSystemFontOfSize:13 weight:NSFontWeightRegular];
            } else {
                // Fallback on earlier versions
            }
        }
        [column.dataCell setFont:font];
    }

    [NSApp setServicesProvider:self];
}

- (void)dealloc {
    [[NSNotificationCenter defaultCenter] removeObserver:self name:kJobQueueFinished object:filesController];
    [credits removeObserver:self forKeyPath:@"effectiveAppearance"];
}

- (void)handleServices:(NSPasteboard *)pboard
              userData:(NSString *)userData
                 error:(NSString **)error {
    NSArray<NSURL *> *urls = IOFileURLsFromPasteboard(pboard);
    if ([urls count]) {
        [filesController performSelectorInBackground:@selector(addURLs:) withObject:urls];
    }
}

static void appendFormatNameIfLossyEnabled(NSUserDefaults *defs, NSString *name, NSString *key, NSMutableArray *arr) {
    NSInteger q = [defs integerForKey:key];
    if (q > 0 && q < 100) {
        [arr addObject:[NSString stringWithFormat:@"%@ %ld%%", name, q]];
    }
}

- (void)initStatusbarWithDefaults:(NSUserDefaults *)defs {
    [[statusBarLabel cell] setBackgroundStyle:NSBackgroundStyleRaised];

    static BOOL overallAvg = NO;
    static NSString *defaultText;
    defaultText = statusBarLabel.stringValue;
    NSByteCountFormatter *sizeFormatter = [[NSByteCountFormatter alloc] init];

    static NSNumberFormatter *percFormatter;
    percFormatter = [NSNumberFormatter new];

    if (quitWhenDone) {
        defaultText = NSLocalizedString(@"ImageOptim 2 will quit when optimizations are complete", @"status bar");
    }

    [percFormatter setMaximumFractionDigits:1];
    [percFormatter setNumberStyle:NSNumberFormatterPercentStyle];

    statusBarUpdateQueue = dispatch_source_create(DISPATCH_SOURCE_TYPE_DATA_OR, 0, 0,
                                                  dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_LOW, 0));
    dispatch_source_set_event_handler(statusBarUpdateQueue, ^{
        NSString *str = defaultText;
        BOOL selectable = NO;
        @synchronized(self->filesController) {
            long long bytesTotal = 0, optimizedTotal = 0;
            double optimizedFractionTotal = 0, maxOptimizedFraction = 0;
            NSUInteger optimizedFileCount = 0;
            BOOL anyBusyFiles = false;

            NSArray *content = [self->filesController content];
            for (JobProxy *f in content) {
                assert([f isKindOfClass:[JobProxy class]]);

                if (!anyBusyFiles && [f isBusy]) {
                    anyBusyFiles = YES;
                }

                const NSUInteger bytes = [f.byteSizeOriginal unsignedIntegerValue];
                const NSUInteger optimized = [f.byteSizeOptimized unsignedIntegerValue];
                if (bytes && optimized && (bytes != optimized || [f isDone])) {
                    const double optimizedFraction = 1.0 - (double)optimized / (double)bytes;
                    if (optimizedFraction > maxOptimizedFraction) {
                        maxOptimizedFraction = optimizedFraction;
                    }
                    optimizedFractionTotal += optimizedFraction;
                    bytesTotal += bytes;
                    optimizedTotal += optimized;
                    optimizedFileCount++;
                }
            }

            if (optimizedFileCount > 1 && bytesTotal) {
                const double savedTotal = 1.0 - (double)optimizedTotal / (double)bytesTotal;
                const double savedAvg = optimizedFractionTotal / (double)optimizedFileCount;
                if (savedTotal > 0.001) {
                    if (savedTotal * 0.8 > savedAvg) {
                        overallAvg = YES;
                    } else if (savedAvg * 0.8 > savedTotal) {
                        overallAvg = NO;
                    }

                    NSString *fmtStr;
                    double avgNum;
                    if (overallAvg) {
                        fmtStr = NSLocalizedString(@"Saved %@ out of %@. %@ overall (up to %@ per file)", "total ratio, status bar");
                        avgNum = savedTotal;
                    } else {
                        fmtStr = NSLocalizedString(@"Saved %@ out of %@. %@ per file on average (up to %@)", "per file avg, status bar");
                        avgNum = savedAvg;
                    }

                    const long long bytesSaved = bytesTotal - optimizedTotal;

                    str = [NSString stringWithFormat:fmtStr,
                                                     [sizeFormatter stringFromByteCount:bytesSaved],
                                                     [sizeFormatter stringFromByteCount:bytesTotal],
                                                     [percFormatter stringFromNumber:@(avgNum)],
                                                     [percFormatter stringFromNumber:@(maxOptimizedFraction)]];
                    selectable = YES;
                }
            } else if ([defs boolForKey:@"GuetzliEnabled"]) {
                str = @"Warning: Guetzli tool enabled. Optimizations may take a very long time.";
            } else if ([defs boolForKey:@"LossyEnabled"]) {
                NSMutableArray *arr = [NSMutableArray new];
                appendFormatNameIfLossyEnabled(defs, @"JPEG", @"JpegOptimMaxQuality", arr);
                appendFormatNameIfLossyEnabled(defs, @"PNG", @"PngMinQuality", arr);
                appendFormatNameIfLossyEnabled(defs, @"GIF", @"GifQuality", arr);
                if ([arr count]) {
                    str = [NSString stringWithFormat:@"%@ (%@)",
                                                     NSLocalizedString(@"Lossy minification enabled", @"status bar"),
                                                     [arr componentsJoinedByString:@", "]];
                }
            } else if (anyBusyFiles) {
                str = @"";
            }

            // that was also in KVO, but caused deadlocks there. Here it's deferred.
            [self->filesController updateStoppableState];
        }

        dispatch_async(dispatch_get_main_queue(), ^() {
            [self->statusBarLabel setStringValue:str];
            [self->statusBarLabel setSelectable:selectable];
        });
        usleep(100000); // 1/10th of a sec to avoid updating statusbar as fast as possible (100% cpu on the statusbar alone is ridiculous)
    });
    dispatch_resume(statusBarUpdateQueue);

    [filesController addObserver:self forKeyPath:@"isBusy" options:0 context:nil];
    [filesController addObserver:self forKeyPath:@"arrangedObjects.@count" options:0 context:nil];
    [filesController addObserver:self forKeyPath:@"arrangedObjects.@sum.byteSizeOptimized" options:0 context:nil];
    [filesController addObserver:self forKeyPath:@"selectionIndexes" options:0 context:(void *)kIMPreviewPanelContext];

    [self updateStatusBar]; // Initial display

    [[NSNotificationCenter defaultCenter] addObserverForName:NSUserDefaultsDidChangeNotification
                                                      object:defs
                                                       queue:[NSOperationQueue mainQueue]
                                                  usingBlock:^(NSNotification *note) {
                                                      [self updateStatusBar];
                                                  }];
}

- (void)updateStatusBar {
    dispatch_source_merge_data(statusBarUpdateQueue, 1);
}

- (void)awakeFromNib {
    if (quitWhenDone) {
        [NSApp hide:self];
    }

    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(jobDidFail:)
                                                 name:IOJobDidFailNotification
                                               object:nil];

    [credits setString:@""];

    // this creates and sets the text for textview
    [self performSelectorInBackground:@selector(loadCreditsHTML:) withObject:nil];
    [credits addObserver:self forKeyPath:@"effectiveAppearance" options:0 context:nil];
}

- (void)loadCreditsHTML:(id)_unused {
    static const char header[] = "<!DOCTYPE html>\
    <meta charset=utf-8>\
    <style>\
    html,body {font:11px/1.5 'Lucida Grande', sans-serif; color: #000; background: transparent; margin:0;}\
    </style>\
    <title>Credits</title>";

    NSMutableData *html = [NSMutableData dataWithBytesNoCopy:(void *)header length:sizeof(header) freeWhenDone:NO];
    NSString*creditsPath = [[NSBundle mainBundle] pathForResource:@"Credits" ofType:@"html"];
    NSData *credits = [NSData dataWithContentsOfFile:creditsPath];
    if (!credits) {
        return;
    }
    [html appendData:credits];
    NSAttributedString *tmpStr = [[NSAttributedString alloc]
              initWithHTML:html
        documentAttributes:nil];

    if (!tmpStr) return;
    dispatch_async(dispatch_get_main_queue(), ^() {
        @try {
            [self->credits setEditable:YES];
            [self->credits insertText:tmpStr replacementRange:NSMakeRange(0, 0)];
            [self->credits setEditable:NO];
            [self adaptCreditsAppearance];
        } @catch (id) { /*nothing*/
        }
    });
}

- (BOOL)isDarkMode {
#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 101400
    if (@available(macOS 10.14, *)) {
        NSAppearanceName bestAppearance = [credits.effectiveAppearance bestMatchFromAppearancesWithNames:@[ NSAppearanceNameAqua, NSAppearanceNameDarkAqua ]];
        return [bestAppearance isEqualToString:NSAppearanceNameDarkAqua];
    }
#endif
    return false;
}

- (void)adaptCreditsAppearance {
    credits.textColor = [self isDarkMode] ? [NSColor whiteColor] : [NSColor blackColor];
}

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
    // Defer and coalesce statusbar updates
    dispatch_source_merge_data(statusBarUpdateQueue, 1);

    if (object == credits && [keyPath isEqualToString:@"effectiveAppearance"]) {
        [self adaptCreditsAppearance];
    }

    if (context == kIMPreviewPanelContext) {
        [previewPanel reloadData];
    }
}

- (void)observeNotification:(NSNotification *)notif {
    if (!filesController.isBusy) {
        if (quitWhenDone) {
            [NSApp terminate:self];
        } else if ([[NSUserDefaults standardUserDefaults] boolForKey:@"BounceDock"]) {
            [NSApp requestUserAttention:NSInformationalRequest];
        }
    }
}

// invoked by Dock
- (void)application:(NSApplication *)sender openFiles:(NSArray *)paths {
    [filesController setRow:-1];
    [sender replyToOpenOrPrint:[filesController addPaths:paths] ? NSApplicationDelegateReplySuccess : NSApplicationDelegateReplyFailure];
}

- (IBAction)quickLookAction:(id)sender {
    [tableView performSelector:@selector(quickLook)];
}

- (IBAction)revert:(id)sender {
    [filesController revert];
}

- (IBAction)stop:(id)sender {
    [filesController stopSelected];
}

- (IBAction)startAgain:(id)sender {
    // alt-click on a button (this is used from menu too, but alternative menu item covers that anyway
    BOOL onlyOptimized = !!([[NSApp currentEvent] modifierFlags] & NSEventModifierFlagOption);
    [filesController startAgainOptimized:onlyOptimized];
}

- (IBAction)startAgainOptimized:(id)sender {
    [filesController startAgainOptimized:YES];
}

- (IBAction)clearComplete:(id)sender {
    [filesController clearComplete];
}

- (IBAction)showPrefs:(id)sender {
    if (!prefsController) {
        prefsController = [PrefsController new];
    }
    [prefsController showWindow:self];
}

- (IBAction)showLossyPrefs:(id)sender {
    if (!prefsController) {
        prefsController = [PrefsController new];
    }
    [prefsController showLossySettings:sender];
}

- (IBAction)openApiHomepage:(id)sender {
    [self openURL:@"https://imageoptim.com/app-api"];
}

- (IBAction)openHomepage:(id)sender {
    [self openURL:@"https://imageoptim.com"];
}

- (IBAction)viewSource:(id)sender {
    [self openURL:@"https://imageoptim.com/source"];
}

- (IBAction)openDonationPage:(id)sender {
    [self openURL:@"https://imageoptim.com/donate.html"];
}

- (void)openURL:(NSString *)stringURL {
    [[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:stringURL]];
}

- (IBAction)browseForFiles:(id)sender {
    NSOpenPanel *oPanel = [NSOpenPanel openPanel];

    [oPanel setAllowsMultipleSelection:YES];
    [oPanel setCanChooseDirectories:YES];
    [oPanel setResolvesAliases:YES];
    [oPanel setAllowedFileTypes:[filesController fileTypes]];

    [oPanel beginSheetModalForWindow:[tableView window]
                   completionHandler:^(NSInteger returnCode) {
                       if (returnCode == NSModalResponseOK) {
                           NSWindow *myWindow = [self->tableView window];
                           [myWindow setStyleMask:[myWindow styleMask] | NSWindowStyleMaskResizable];
                           [self->filesController setRow:-1];
                           [self->filesController addURLs:oPanel.URLs];
                       }
                   }];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)theApplication {
    return YES;
}

- (void)applicationWillTerminate:(NSNotification *)n {
    [filesController cleanup];
}

- (NSString *)version {
    return [[NSBundle mainBundle] infoDictionary][@"CFBundleShortVersionString"];
}

// Quick Look panel support
- (BOOL)acceptsPreviewPanelControl:(QLPreviewPanel *)panel;
{
    return YES;
}

- (void)beginPreviewPanelControl:(QLPreviewPanel *)panel {
    // This document is now responsible of the preview panel
    // It is allowed to set the delegate, data source and refresh panel.
    previewPanel = panel;
    panel.delegate = self;
    panel.dataSource = self;
}

- (void)endPreviewPanelControl:(QLPreviewPanel *)panel {
    // This document loses its responsisibility on the preview panel
    // Until the next call to -beginPreviewPanelControl: it must not
    // change the panel's delegate, data source or refresh it.
    previewPanel = nil;
}

// Quick Look panel data source
- (NSInteger)numberOfPreviewItemsInPreviewPanel:(QLPreviewPanel *)panel {
    return [[filesController selectedObjects] count];
}

- (id<QLPreviewItem>)previewPanel:(QLPreviewPanel *)panel previewItemAtIndex:(NSInteger)index {
    return [filesController selectedObjects][index];
}

// Quick Look panel delegate
- (BOOL)previewPanel:(QLPreviewPanel *)panel handleEvent:(NSEvent *)event {
    // redirect all key down events to the table view
    if ([event type] == NSEventTypeKeyDown) {
        [tableView keyDown:event];
        return YES;
    }
    return NO;
}

- (BOOL)validateMenuItem:(NSMenuItem *)menuItem {
    SEL action = [menuItem action];
    if (action == @selector(startAgain:)) {
        return [filesController canStartAgainOptimized:NO];
    } else if (action == @selector(startAgainOptimized:)) {
        return [filesController canStartAgainOptimized:YES];
    } else if (action == @selector(clearComplete:)) {
        return [filesController canClearComplete];
    } else if (action == @selector(revert:)) {
        return [filesController canRevert];
    } else if (action == @selector(stop:)) {
        return [filesController isStoppable];
    }

    return [menuItem isEnabled];
}

// This delegate method provides the rect on screen from which the panel will zoom.
- (NSRect)previewPanel:(QLPreviewPanel *)panel sourceFrameOnScreenForPreviewItem:(id<QLPreviewItem>)item {
    NSInteger index = [[filesController arrangedObjects] indexOfObject:item];
    if (index == NSNotFound) {
        return NSZeroRect;
    }

    NSRect iconRect = [tableView frameOfCellAtColumn:0 row:index];

    // check that the icon rect is visible on screen
    NSRect visibleRect = [tableView visibleRect];

    if (!NSIntersectsRect(visibleRect, iconRect)) {
        return NSZeroRect;
    }

    // convert icon rect to screen coordinates
    iconRect.origin = [tableView convertPoint:iconRect.origin toView:nil];
    iconRect = [tableView.window convertRectToScreen:iconRect];

    return iconRect;
}


#pragma mark - Failure toast

- (void)jobDidFail:(NSNotification *)note {
    NSString *reason = [note userInfo][IOJobFailureReasonKey];
    NSURL *path = [note userInfo][IOJobFailurePathKey];
    // Jobs fail on worker threads.
    dispatch_async(dispatch_get_main_queue(), ^{
        [self showFailureToastWithReason:reason path:path];
    });
}

- (void)showFailureToastWithReason:(NSString *)reason path:(NSURL *)path {
    NSView *content = [[tableView window] contentView];
    if (!content || ![reason length]) {
        return;
    }

    self.failureCount += 1;

    if (!self.failureToast) {
        [self buildFailureToastInView:content];
    }

    NSString *text;
    if (self.failureCount == 1) {
        NSString *name = [path lastPathComponent];
        text = name ? [NSString stringWithFormat:@"%@ \u2014 %@", name, reason] : reason;
    } else {
        text = [NSString stringWithFormat:NSLocalizedString(@"%lu files could not be saved \u2014 %@", @"failure toast: count, reason"),
                                          (unsigned long)self.failureCount, reason];
    }
    self.failureToastLabel.stringValue = text;
    self.failureToast.toolTip = text;

    [self layoutFailureToastInView:content];
    self.failureToast.hidden = NO;
    self.failureToast.alphaValue = 1.0;

    // Each new failure extends the window rather than stacking toasts.
    [self.failureToastTimer invalidate];
    __weak ImageOptimController *weakSelf = self;
    self.failureToastTimer = [NSTimer scheduledTimerWithTimeInterval:10.0 repeats:NO block:^(NSTimer *timer) {
        [weakSelf dismissFailureToast:nil];
    }];
}

- (void)buildFailureToastInView:(NSView *)content {
    NSVisualEffectView *toast = [[NSVisualEffectView alloc] initWithFrame:NSZeroRect];
    toast.material = NSVisualEffectMaterialHUDWindow;
    toast.blendingMode = NSVisualEffectBlendingModeWithinWindow;
    toast.state = NSVisualEffectStateActive;
    toast.wantsLayer = YES;
    toast.layer.cornerRadius = 10.0;
    toast.layer.masksToBounds = YES;
    toast.autoresizingMask = NSViewMinXMargin | NSViewMaxXMargin | NSViewMaxYMargin;

    NSImageView *icon = [[NSImageView alloc] initWithFrame:NSZeroRect];
    icon.imageScaling = NSImageScaleProportionallyDown;
    if (@available(macOS 11.0, *)) {
        icon.image = [NSImage imageWithSystemSymbolName:@"exclamationmark.triangle.fill" accessibilityDescription:nil];
        icon.contentTintColor = [NSColor systemRedColor];
    }
    [toast addSubview:icon];

    NSTextField *label = [NSTextField labelWithString:@""];
    label.font = [NSFont systemFontOfSize:[NSFont smallSystemFontSize]];
    label.lineBreakMode = NSLineBreakByTruncatingTail;
    label.maximumNumberOfLines = 2;
    [toast addSubview:label];

    NSButton *close = [NSButton buttonWithTitle:@"" target:self action:@selector(dismissFailureToast:)];
    close.bordered = NO;
    close.bezelStyle = NSBezelStyleInline;
    if (@available(macOS 11.0, *)) {
        close.image = [NSImage imageWithSystemSymbolName:@"xmark" accessibilityDescription:NSLocalizedString(@"Dismiss", @"failure toast button")];
    } else {
        close.title = @"\u2715";
    }
    [toast addSubview:close];

    self.failureToast = toast;
    self.failureToastLabel = label;
    self.failureToastIcon = icon;
    self.failureToastClose = close;
    [content addSubview:toast];
}

- (void)layoutFailureToastInView:(NSView *)content {
    const CGFloat height = 44.0, margin = 16.0, pad = 12.0, iconSize = 18.0, closeSize = 16.0, gap = 8.0;

    CGFloat available = NSWidth(content.bounds) - 2.0 * margin;
    CGFloat width = MIN(480.0, available);
    if (width < 200.0) {
        width = available;
    }

    self.failureToast.frame = NSMakeRect(round((NSWidth(content.bounds) - width) / 2.0), margin, width, height);
    self.failureToastIcon.frame = NSMakeRect(pad, round((height - iconSize) / 2.0), iconSize, iconSize);
    self.failureToastClose.frame = NSMakeRect(width - pad - closeSize, round((height - closeSize) / 2.0), closeSize, closeSize);

    CGFloat labelX = pad + iconSize + gap;
    CGFloat labelWidth = width - labelX - closeSize - pad - gap;
    self.failureToastLabel.frame = NSMakeRect(labelX, 6.0, MAX(labelWidth, 20.0), height - 12.0);
}

- (IBAction)dismissFailureToast:(id)sender {
    [self.failureToastTimer invalidate];
    self.failureToastTimer = nil;
    self.failureCount = 0;

    NSVisualEffectView *toast = self.failureToast;
    self.failureToast = nil;
    if (!toast) {
        return;
    }

    [NSAnimationContext runAnimationGroup:^(NSAnimationContext *ctx) {
        ctx.duration = 0.25;
        [[toast animator] setAlphaValue:0.0];
    } completionHandler:^{
        [toast removeFromSuperview];
    }];
}

@end
