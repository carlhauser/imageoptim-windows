//
//  PrefsController.m
//
//  Created by porneL on 24.wrz.07.
//

#import "PrefsController.h"
#import "ImageOptimController.h"
#import "Transformers.h"

static const char *kGuetzliContext = "guetzli";
static const char *kStripAllContext = "strip";

@interface PrefsController () <NSTabViewDelegate, NSTableViewDataSource, NSTableViewDelegate>
@property (weak) NSTableView *sidebarList;
@end

@implementation PrefsController

- (instancetype)init {
    if ((self = [super initWithWindowNibName:@"PrefsController"])) {
        CeilFormatter *cf = [CeilFormatter new];
        [NSValueTransformer setValueTransformer:cf forName:@"CeilFormatter"];

        DisabledColor *dc = [DisabledColor new];
        [NSValueTransformer setValueTransformer:dc forName:@"DisabledColor"];

        [[NSUserDefaults standardUserDefaults] addObserver:self forKeyPath:@"GuetzliEnabled" options:0 context:(void *)kGuetzliContext];
        [[NSUserDefaults standardUserDefaults] addObserver:self forKeyPath:@"JpegTranStripAll" options:0 context:(void *)kStripAllContext];
    }
    return self;
}

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)defaults
                        change:(NSDictionary *)change
                       context:(void *)context {
    if (context == (void *)kGuetzliContext) {
        if ([defaults boolForKey:@"GuetzliEnabled"]) {
            if (!notified) {
                notified = YES;
                [self warnGuetzliSlowness];
            }
            if ([defaults integerForKey:@"JpegOptimMaxQuality"] < 85) {
                [defaults setInteger:85 forKey:@"JpegOptimMaxQuality"];
            }
            if (![defaults boolForKey:@"JpegTranStripAll"]) {
                [defaults setBool:YES forKey:@"JpegTranStripAllSetByGuetzli"];
                [defaults setBool:YES forKey:@"JpegTranStripAll"];
            }
        } else if ([defaults boolForKey:@"JpegTranStripAll"] && [defaults boolForKey:@"JpegTranStripAllSetByGuetzli"]) {
            [defaults setBool:NO forKey:@"JpegTranStripAllSetByGuetzli"];
            [defaults setBool:NO forKey:@"JpegTranStripAll"];
        }
    } else if (context == (void *)kStripAllContext) {
        if ([defaults boolForKey:@"GuetzliEnabled"] && ![defaults boolForKey:@"JpegTranStripAll"]) {
            [defaults setBool:NO forKey:@"JpegTranStripAllSetByGuetzli"];
            [defaults setBool:NO forKey:@"GuetzliEnabled"];
        }
    }
}

- (void)warnGuetzliSlowness {
    NSAlert *alert = [NSAlert new];
    alert.alertStyle = NSAlertStyleWarning;
    alert.messageText = NSLocalizedString(@"Guetzli is very slow", "alert box");
    alert.informativeText = NSLocalizedString(@"It can take up to 30 minutes per image. Your system may be unresponsive while Guetzli is running.", "alert box");
    [alert beginSheetModalForWindow:[self window] completionHandler:nil];
}

- (IBAction)showLossySettings:(id)sender {
    [self showWindow:sender];
    [self.tabs selectTabViewItemAtIndex:1];
}

- (IBAction)showHelp:(id)sender {
    NSInteger tag = [sender tag];

    [[self window] setHidesOnDeactivate:NO];

    NSString *locBookName = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleHelpBookName"];
    NSString *anchors[] = { @"general", @"jpegoptim", @"optipng", @"optipng", @"pngcrush", @"pngout" };
    NSString *anchor = @"main";

    if (tag >= 1 && tag <= 6) {
        anchor = anchors[tag - 1];
    }
    [[NSHelpManager sharedHelpManager] openHelpAnchor:anchor inBook:locBookName];
}

// This doesn't belong here :(
- (BOOL)svgSupported {
    NSFileManager *fm = [NSFileManager defaultManager];
    return [fm isExecutableFileAtPath:@"/usr/local/bin/node"] || [fm isExecutableFileAtPath:@"/opt/homebrew/bin/node"];
}

#pragma mark - Sidebar pane switching

- (void)windowDidLoad {
    [super windowDidLoad];

    self.tabs.delegate = self;
    self.tabs.tabViewType = NSNoTabsNoBorder;

    [self installSidebar];
    [self syncSidebarSelectionAndTitle];
}

/* Wraps the nib's content view in a split view so the panes get a real sidebar.
   The nib's own layout is untouched: its content view simply becomes the
   trailing split item.
 */
- (void)installSidebar {
    NSWindow *window = self.window;
    NSView *paneContainer = window.contentView;
    if (!paneContainer) {
        return;
    }

    NSTableView *list = [[NSTableView alloc] initWithFrame:NSMakeRect(0.0, 0.0, 190.0, 376.0)];
    list.headerView = nil;
    list.selectionHighlightStyle = NSTableViewSelectionHighlightStyleSourceList;
    list.allowsEmptySelection = NO;
    list.allowsMultipleSelection = NO;
    list.rowHeight = 28.0;
    list.backgroundColor = [NSColor clearColor];
    list.dataSource = self;
    list.delegate = self;

    NSTableColumn *column = [[NSTableColumn alloc] initWithIdentifier:@"pane"];
    column.resizingMask = NSTableColumnAutoresizingMask;
    [list addTableColumn:column];

    NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(0.0, 0.0, 190.0, 376.0)];
    scroll.documentView = list;
    scroll.drawsBackground = NO;
    scroll.hasVerticalScroller = YES;
    scroll.autohidesScrollers = YES;

    NSViewController *sidebarController = [NSViewController new];
    sidebarController.view = scroll;

    // Detach the nib's content view before it becomes a child of the split view.
    window.contentView = [[NSView alloc] initWithFrame:paneContainer.bounds];
    NSViewController *paneController = [NSViewController new];
    paneController.view = paneContainer;

    NSSplitViewController *split = [NSSplitViewController new];
    NSSplitViewItem *sidebarItem;
    if (@available(macOS 11.0, *)) {
        sidebarItem = [NSSplitViewItem sidebarWithViewController:sidebarController];
    } else {
        sidebarItem = [NSSplitViewItem splitViewItemWithViewController:sidebarController];
    }
    sidebarItem.minimumThickness = 170.0;
    sidebarItem.maximumThickness = 220.0;
    sidebarItem.canCollapse = NO;
    [split addSplitViewItem:sidebarItem];
    [split addSplitViewItem:[NSSplitViewItem splitViewItemWithViewController:paneController]];

    self.sidebarList = list;
    window.contentViewController = split;

    // The nib sized this window for the panes alone, and capped it below even that.
    const CGFloat paneWidth = 663.0, sidebarWidth = 190.0, paneHeight = 376.0;
    window.maxSize = NSMakeSize(1400.0, 1200.0);
    window.minSize = NSMakeSize(paneWidth + sidebarWidth, paneHeight);

    NSRect frame = window.frame;
    if (NSWidth(frame) < paneWidth + sidebarWidth) {
        frame.size.width = paneWidth + sidebarWidth;
        [window setFrame:frame display:NO];
    }
}

- (NSImage *)sidebarImageForPaneIndex:(NSInteger)index API_AVAILABLE(macos(11.0)) {
    NSArray<NSString *> *symbolNames = @[ @"gearshape", @"slider.horizontal.3", @"speedometer" ];
    NSString *name = (index >= 0 && index < (NSInteger)[symbolNames count]) ? symbolNames[index] : @"gearshape";
    return [NSImage imageWithSystemSymbolName:name accessibilityDescription:nil];
}

- (NSInteger)numberOfRowsInTableView:(NSTableView *)tableView {
    return [self.tabs numberOfTabViewItems];
}

- (NSView *)tableView:(NSTableView *)tableView viewForTableColumn:(NSTableColumn *)tableColumn row:(NSInteger)row {
    if (row < 0 || row >= [self.tabs numberOfTabViewItems]) {
        return nil;
    }

    NSTableCellView *cell = [tableView makeViewWithIdentifier:@"PaneCell" owner:self];
    if (!cell) {
        cell = [[NSTableCellView alloc] initWithFrame:NSMakeRect(0.0, 0.0, 190.0, 28.0)];
        cell.identifier = @"PaneCell";

        NSImageView *icon = [[NSImageView alloc] initWithFrame:NSMakeRect(4.0, 5.0, 18.0, 18.0)];
        icon.imageScaling = NSImageScaleProportionallyDown;
        icon.autoresizingMask = NSViewMaxXMargin;
        [cell addSubview:icon];
        cell.imageView = icon;

        NSTextField *label = [NSTextField labelWithString:@""];
        label.frame = NSMakeRect(30.0, 5.0, 152.0, 17.0);
        label.autoresizingMask = NSViewWidthSizable;
        label.lineBreakMode = NSLineBreakByTruncatingTail;
        [cell addSubview:label];
        cell.textField = label;
    }

    NSTabViewItem *tab = [self.tabs tabViewItemAtIndex:row];
    cell.textField.stringValue = [tab label] ?: @"";
    if (@available(macOS 11.0, *)) {
        cell.imageView.image = [self sidebarImageForPaneIndex:row];
    }
    return cell;
}

- (void)tableViewSelectionDidChange:(NSNotification *)notification {
    if ([notification object] != self.sidebarList) {
        return;
    }

    NSInteger row = [self.sidebarList selectedRow];
    if (row >= 0 && row < [self.tabs numberOfTabViewItems]) {
        [self.tabs selectTabViewItemAtIndex:row];
    }
}

- (void)tabView:(NSTabView *)tabView didSelectTabViewItem:(NSTabViewItem *)tabViewItem {
    [self syncSidebarSelectionAndTitle];
}

// The sidebar is the only pane affordance, so the window title names the visible
// pane the way Apple's own settings windows do.
- (void)syncSidebarSelectionAndTitle {
    NSTabViewItem *selected = [self.tabs selectedTabViewItem];
    if (!selected) {
        return;
    }
    NSInteger index = [self.tabs indexOfTabViewItem:selected];
    if (index == NSNotFound) {
        return;
    }

    if (self.sidebarList && [self.sidebarList selectedRow] != index) {
        [self.sidebarList selectRowIndexes:[NSIndexSet indexSetWithIndex:index] byExtendingSelection:NO];
    }
    [[self window] setTitle:[selected label]];
}

@end
