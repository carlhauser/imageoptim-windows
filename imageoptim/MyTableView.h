/* MyTableView */

@import Cocoa;

@interface MyTableView : NSTableView
- (IBAction)delete:(id)sender;
- (IBAction)copyAsDataURI:(id)sender;
- (IBAction)openInFinder:(id)sender;
- (void)quickLook;
@end
