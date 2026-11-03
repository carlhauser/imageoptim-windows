#import "MyTableView.h"
#import "FilesController.h"
#import "JobProxy.h"
#import "File.h"
#import "log.h"

@import Quartz;
@implementation MyTableView

- (void)removeObjects:(NSArray *)objects {
    FilesController *f = (FilesController *)[self delegate];

    [[self undoManager] registerUndoWithTarget:self selector:@selector(addObjects:) object:objects];
    [f removeObjects:objects];
}

- (void)addObjects:(NSArray *)objects {
    FilesController *f = (FilesController *)[self delegate];

    [[self undoManager] registerUndoWithTarget:self selector:@selector(removeObjects:) object:objects];
    [f addObjects:objects];
}

- (IBAction)delete:(id)sender {
    FilesController *f = (FilesController *)[self delegate];
    [self removeObjects:[f selectedObjects]];
}

- (IBAction)copy:(id)sender {
    FilesController *f = (FilesController *)[self delegate];

    NSArray *selected = [f selectedObjects];
    NSMutableArray<NSURL *> *fileURLs = [NSMutableArray arrayWithCapacity:[selected count]];
    NSMutableArray *fileNames = [NSMutableArray arrayWithCapacity:[selected count]];
    for (JobProxy *job in selected) {
        assert([job isKindOfClass:[JobProxy class]]);
        NSURL *url = job.filePath;
        NSString *path = url.path;
        if (path) {
            [fileURLs addObject:url];
            [fileNames addObject:[path.lastPathComponent stringByAddingPercentEncodingWithAllowedCharacters:[NSCharacterSet URLPathAllowedCharacterSet]]];
        }
    };
    if ([fileURLs count]) {
        NSMutableArray<NSPasteboardItem *> *items = [NSMutableArray arrayWithCapacity:[fileURLs count]];
        for (NSURL *url in fileURLs) {
            NSPasteboardItem *item = [NSPasteboardItem new];
            [item setString:[url absoluteString] forType:NSPasteboardTypeFileURL];
            [items addObject:item];
        }
        // Keep the text flavour this used to write: percent-encoded file names, one
        // per line. Letting NSURL supply it instead would paste full paths.
        [[items firstObject] setString:[fileNames componentsJoinedByString:@"\n"] forType:NSPasteboardTypeString];

        NSPasteboard *pboard = [NSPasteboard generalPasteboard];
        [pboard clearContents];
        [pboard writeObjects:items];
    }
}

- (BOOL)allowsVibrancy {
    return false;
}

- (NSArray<File *> *)filesForDataURI {
    FilesController *f = (FilesController *)[self delegate];

    NSArray *selectedFiles = [f selectedObjects];
    NSMutableArray *files = [NSMutableArray arrayWithCapacity:[selectedFiles count]];
    NSUInteger totalSize = 0;
    for (JobProxy *job in selectedFiles) {
        assert([job isKindOfClass:[JobProxy class]]);
        if (![job isDone]) continue;
        File *file = [job savedOutputOrInput];
        if (!file || file.byteSize > 100000) continue;
        totalSize += file.byteSize;
        if (totalSize > 1000000) break;
        [files addObject:file];
    }
    return files;
}

- (IBAction)copyAsDataURI:(id)sender {
    NSMutableArray *urls = [NSMutableArray new];
    for (File *file in [self filesForDataURI]) {
        NSData *data = [NSData dataWithContentsOfURL:file.path];

        NSString *type = [file mimeType];
        if (!type) continue;

        NSString *url = [[NSString stringWithFormat:@"data:%@;base64,", type]
            stringByAppendingString:[data base64EncodedStringWithOptions:0]];

        [urls addObject:url];
    }

    NSPasteboard *pboard = [NSPasteboard generalPasteboard];

    [pboard clearContents];
    [pboard setString:[urls componentsJoinedByString:@"\n"] forType:NSPasteboardTypeString];
}

- (IBAction)cut:(id)sender {
    [self copy:sender];
    [self delete:sender];
    [[self undoManager] setActionName:NSLocalizedString(@"Cut", @"undo command name")];
}

- (IBAction)paste:(id)sender {
    NSPasteboard *pboard = [NSPasteboard generalPasteboard];

    NSArray<NSURL *> *urls = IOFileURLsFromPasteboard(pboard);

    FilesController *f = (FilesController *)[self delegate];
    [f addURLsBelowSelection:urls];
}

- (BOOL)validateMenuItem:(NSMenuItem *)menuItem {
    SEL action = [menuItem action];

    if (action == @selector(delete:) || action == @selector(copy:) || action == @selector(cut:)) {
        return [self numberOfSelectedRows] > 0;
    } else if (action == @selector(copyAsDataURI:)) {
        NSData *data = [NSData data];
        return [data respondsToSelector:@selector(base64Encoding)] && [self numberOfSelectedRows] > 0 && [[self filesForDataURI] count] > 0;
    } else if (action == @selector(paste:)) {
        NSPasteboard *pboard = [NSPasteboard generalPasteboard];
        return [IOFileURLsFromPasteboard(pboard) count] > 0;
    } else if (action == @selector(selectAll:)) {
        return [self numberOfRows] > 0;
    }
    return [menuItem isEnabled];
}

- (void)keyDown:(NSEvent *)theEvent {
    if (![theEvent isARepeat] && [self numberOfSelectedRows]) {
        switch ([theEvent keyCode]) {
            case 49: /*space*/
                [self quickLook];
                return;
            case 51: /*backspace*/
            case 117: /*delete*/
                [self delete:self];
                return;
        }
    }

    [super keyDown:theEvent];
}

- (NSDragOperation)draggingSession:(NSDraggingSession *)session
    sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
    if (context == NSDraggingContextWithinApplication) {
        return NSDragOperationMove;
    }

    return NSDragOperationCopy | NSDragOperationGeneric;
}

- (void)quickLook {
    if ([QLPreviewPanel sharedPreviewPanelExists] && [[QLPreviewPanel sharedPreviewPanel] isVisible]) {
        [[QLPreviewPanel sharedPreviewPanel] orderOut:nil];
    } else {
        [[QLPreviewPanel sharedPreviewPanel] makeKeyAndOrderFront:nil];
    }
}

- (void)awakeFromNib {
    [self setDoubleAction:@selector(openInFinder:)];
}

- (NSArray *)clickedRowSelection {
    FilesController *fc = (FilesController *)[self delegate];
    assert([fc isKindOfClass:[FilesController class]]);

    NSInteger row = [self clickedRow];
    if (row < 0) {
        return nil;
    } else if ([self isRowSelected:row] && [self numberOfSelectedRows] > 1) {
        return [fc selectedObjects];
    } else {
        return @[ [fc arrangedObjects][row] ];
    }
}

- (void)openInFinder:(id)sender {
    NSArray *files = [self clickedRowSelection];
    if (!files) return; // double-click on header
    [[NSWorkspace sharedWorkspace] activateFileViewerSelectingURLs:[files valueForKey:@"filePath"]];
}
@end
