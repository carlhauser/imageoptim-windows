
@import Cocoa;

/// Base cell view for the file table. Carries the row's status text as its tooltip,
/// which the cell-based table used to supply via tableView:toolTipForCell:.
@interface IOTableCellView : NSTableCellView
@end

/// Status column: spins the progress symbol while the job is running.
@interface IOStatusCellView : IOTableCellView
@end

/// File-name column: the file name plus a reveal-in-Finder button that brightens on hover.
@interface FileNameCellView : IOTableCellView
@property (weak) IBOutlet NSButton *revealButton;

- (IBAction)revealInFinder:(id)sender;
@end
