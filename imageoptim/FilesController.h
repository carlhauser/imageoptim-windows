//
//  FilesController.h
//
//  Created by porneL on 23.wrz.07.
//

@import Cocoa;

@class File, ResultsDb, JobProxy;
extern NSString *const kJobQueueFinished;

/// Dropped/pasted files, read as file URLs. Prefers NSPasteboardTypeFileURL, which
/// is what modern senders provide, and falls back to the legacy filenames list.
extern NSArray<NSURL *> *IOFileURLsFromPasteboard(NSPasteboard *pboard);

@interface FilesController : NSArrayController<NSTableViewDelegate, NSTableViewDataSource>

- (void)configureWithTableView:(NSTableView *)a;

- (void)addURLsBelowSelection:(NSArray<NSURL *> *)paths;
- (BOOL)addURLs:(NSArray<NSURL *> *)paths;
- (BOOL)addPaths:(NSArray<NSString *> *)paths;
- (BOOL)addURLs:(NSArray<NSURL *> *)paths filesOnly:(BOOL)t;

- (void)moveObjectsInArrangedObjectsFromIndexes:(NSIndexSet *)indexSet
                                        toIndex:(NSUInteger)insertIndex;
- (NSUInteger)rowsAboveRow:(NSUInteger)row inIndexSet:(NSIndexSet *)indexSet;
- (NSUInteger)numberOfRowsInTableView:(NSTableView *)tableview;

- (void)startAgainOptimized:(BOOL)optimized;
- (BOOL)canStartAgainOptimized:(BOOL)optimized;
- (void)clearComplete;
@property (readonly) BOOL canClearComplete;
- (void)revert;
@property (readonly) BOOL canRevert;
- (void)cleanup;
- (void)setRow:(NSInteger)row;

- (void)stopSelected;
- (void)updateStoppableState;
- (NSNumber *)queueCount;

@property (readonly, copy) NSArray *fileTypes;
@property (readonly) BOOL isBusy, isStoppable;

@end
