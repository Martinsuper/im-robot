/// EventKit bridge for Piko calendar sync.
///
/// This file provides C-callable functions that wrap Apple's EventKit framework,
/// allowing the Rust side to read/write system calendar events without going
/// through osascript / AppleEvents (which requires a separate TCC permission).
///
/// Compiled and linked by build.rs into the main Tauri binary so that the
/// host app's Calendar TCC authorization is inherited automatically.

#import <Foundation/Foundation.h>
#import <EventKit/EventKit.h>
#include <string.h>
#include <stdlib.h>

static NSString *const PikoCalendarName = @"Piko";
static NSString *const MarkerPrefix = @"PIKO_SYNC local_id=";

// Never let Objective-C exceptions unwind across the C ABI into Rust.
static char *piko_calendar_error(NSString *message) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"error": message ?: @"EventKit error"} options:0 error:nil];
    NSString *text = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
    return strdup(text.UTF8String ?: "{\"error\":\"EventKit error\"}");
}

static char *piko_calendar_json(id value) {
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:&error];
    NSString *text = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
    if (!text) return piko_calendar_error(error.localizedDescription ?: @"Calendar serialization failed");
    return strdup(text.UTF8String);
}

/// Returns the EventKit calendar authorization status as a C string.
/// Possible values: "authorized", "denied", "restricted", "notDetermined".
/// The returned pointer is to a string literal and must NOT be freed.
const char *piko_calendar_auth_status(void) {
    @try {
        EKAuthorizationStatus status =
            [EKEventStore authorizationStatusForEntityType:EKEntityTypeEvent];
        // 3 covers both EKAuthorizationStatusAuthorized (deprecated) and
        // EKAuthorizationStatusFullAccess — they share the same underlying value.
        if (status == 3) return "authorized";
        if (status == 2) return "denied";
        if (status == 1) return "restricted";
        return "notDetermined";
    } @catch (NSException *exception) {
        return "unavailable";
    }
}

/// Request EventKit calendar access. This triggers the macOS permission dialog
/// if the user hasn't made a choice yet.
/// Returns "authorized" or "denied" after the user responds.
/// This function blocks until the user responds (up to 60 seconds).
char *piko_calendar_request_access(void) {
    @autoreleasepool {
        @try {
            NSString *usageKey;
            if (@available(macOS 14.0, *)) usageKey = @"NSCalendarsFullAccessUsageDescription";
            else usageKey = @"NSCalendarsUsageDescription";
            id usage = [[NSBundle mainBundle] objectForInfoDictionaryKey:usageKey];
            if (![usage isKindOfClass:[NSString class]] || [usage length] == 0) return strdup("missingUsageDescription");
            EKEventStore *store = [[EKEventStore alloc] init];

            // Use the modern API for macOS 14+ and fall back for older versions
            dispatch_semaphore_t sema = dispatch_semaphore_create(0);
            __block BOOL granted = NO;

            if (@available(macOS 14.0, *)) {
                [store requestFullAccessToEventsWithCompletion:^(BOOL accessGranted, NSError *error) {
                    granted = accessGranted;
                    dispatch_semaphore_signal(sema);
                }];
            } else {
                [store requestAccessToEntityType:EKEntityTypeEvent completion:^(BOOL accessGranted, NSError *error) {
                    granted = accessGranted;
                    dispatch_semaphore_signal(sema);
                }];
            }

            // Wait up to 60 seconds for the user to respond
            long result = dispatch_semaphore_wait(sema, dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC));
            if (result != 0) {
                return strdup("timeout");
            }

            return strdup(granted ? "authorized" : "denied");
        } @catch (NSException *exception) {
            return strdup("exception");
        }
    }
}

/// Parse the PIKO_SYNC marker from an event's notes.
/// Returns the localId (caller must free) or NULL if no marker found.
static char *parse_marker(const char *notes) {
    if (!notes) return NULL;
    NSString *notesStr = [NSString stringWithUTF8String:notes];
    NSRange range = [notesStr rangeOfString:MarkerPrefix];
    if (range.location == NSNotFound) return NULL;

    NSString *after = [notesStr substringFromIndex:range.location + range.length];
    // Take the first line as localId
    NSRange newlineRange = [after rangeOfCharacterFromSet:[NSCharacterSet newlineCharacterSet]];
    NSString *localId;
    if (newlineRange.location != NSNotFound) {
        localId = [[after substringToIndex:newlineRange.location]
                    stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    } else {
        localId = [after stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    }

    if (localId.length == 0) return NULL;
    return strdup([localId UTF8String]);
}

// EventKit truncates predicates longer than four years. Query one year at a time.
static NSArray<NSArray<NSDate *> *> *piko_calendar_windows(NSDate *start, NSDate *end) {
    NSMutableArray *windows = [NSMutableArray array];
    NSDate *cursor = start;
    while ([cursor compare:end] == NSOrderedAscending) {
        NSDate *next = [[NSCalendar currentCalendar] dateByAddingUnit:NSCalendarUnitYear value:1 toDate:cursor options:0];
        if (!next || [next compare:cursor] != NSOrderedDescending) break;
        if ([next compare:end] == NSOrderedDescending) next = end;
        [windows addObject:@[cursor, next]];
        cursor = next;
    }
    return windows;
}

/// Pull all events from all calendars, returning a JSON string.
/// The caller must free() the returned string.
char *piko_calendar_pull(void) {
    @autoreleasepool {
        @try {
        EKEventStore *store = [[EKEventStore alloc] init];
        NSArray<EKCalendar *> *calendars =
            [store calendarsForEntityType:EKEntityTypeEvent];

        // Use a reasonable date range: 10 years ago to 2 years from now.
        // EventKit predicates may not work correctly with extreme dates (epoch 0).
        NSDateComponents *startComponents = [[NSDateComponents alloc] init];
        startComponents.year = -10;
        NSDate *startDate = [[NSCalendar currentCalendar] dateByAddingComponents:startComponents
                                                                       toDate:[NSDate date]
                                                                      options:0];

        NSDateComponents *endComponents = [[NSDateComponents alloc] init];
        endComponents.year = 2;
        NSDate *endDate = [[NSCalendar currentCalendar] dateByAddingComponents:endComponents
                                                                      toDate:[NSDate date]
                                                                     options:0];

        NSMutableArray *result = [NSMutableArray array];

        NSMutableSet *seen = [NSMutableSet set];
        for (EKCalendar *cal in calendars) {
          for (NSArray<NSDate *> *window in piko_calendar_windows(startDate, endDate)) {
            NSPredicate *predicate = [store predicateForEventsWithStartDate:startDate
                                                                   endDate:endDate
                                                                 calendars:@[cal]];
            NSArray<EKEvent *> *events = [store eventsMatchingPredicate:predicate];

            for (EKEvent *event in events) {
                if (!event.startDate || !event.endDate) continue;
                NSString *key = [NSString stringWithFormat:@"%@|%@|%.0f", cal.calendarIdentifier ?: @"", event.eventIdentifier ?: @"", event.startDate.timeIntervalSince1970];
                if ([seen containsObject:key]) continue;
                [seen addObject:key];
                NSMutableDictionary *entry = [NSMutableDictionary dictionary];

                // Parse sync marker from notes
                const char *notesCStr = event.notes ? [event.notes UTF8String] : NULL;
                char *localId = parse_marker(notesCStr);

                // If marker present but localId empty, skip
                if (notesCStr && strstr(notesCStr, "PIKO_SYNC local_id=") && !localId) {
                    continue;
                }

                entry[@"localId"] = localId ? [NSString stringWithUTF8String:localId] : @"";
                if (localId) free(localId);

                entry[@"systemId"] = event.eventIdentifier ?: @"";
                entry[@"title"] = event.title ?: @"";
                entry[@"startAt"] = @((long long)[event.startDate timeIntervalSince1970]);
                entry[@"endAt"] = @((long long)[event.endDate timeIntervalSince1970]);
                entry[@"platform"] = @"macos";
                entry[@"calendarName"] = cal.title ?: @"";

                if (event.location.length > 0) {
                    entry[@"location"] = event.location;
                }

                // Clean notes (without sync marker)
                if (event.notes.length > 0) {
                    NSString *notes = event.notes;
                    NSRange markerRange = [notes rangeOfString:MarkerPrefix];
                    if (markerRange.location != NSNotFound) {
                        NSString *before = [[notes substringToIndex:markerRange.location]
                                            stringByTrimmingCharactersInSet:
                                                [NSCharacterSet whitespaceAndNewlineCharacterSet]];
                        if (before.length > 0) {
                            entry[@"notes"] = before;
                        }
                    } else {
                        entry[@"notes"] = [notes stringByTrimmingCharactersInSet:
                                            [NSCharacterSet whitespaceAndNewlineCharacterSet]];
                    }
                }

                if (event.lastModifiedDate) {
                    entry[@"systemModifiedAt"] =
                        @((long long)[event.lastModifiedDate timeIntervalSince1970]);
                } else {
                    entry[@"systemModifiedAt"] =
                        @((long long)[[NSDate date] timeIntervalSince1970]);
                }

                [result addObject:entry];
            }
        }

          }
        return piko_calendar_json(result);
        } @catch (NSException *exception) {
            return piko_calendar_error(exception.reason ?: exception.name);
        }
    }
}

/// Push events into the Piko calendar. Input is a JSON string (array of event dicts).
/// Returns a JSON string with created/updated event mappings.
/// The caller must free() the returned string.
char *piko_calendar_push(const char *json) {
    @autoreleasepool {
        @try {
        if (!json) return strdup("[]");

        EKEventStore *store = [[EKEventStore alloc] init];

        NSData *jsonData = [NSData dataWithBytes:json length:strlen(json)];
        id parsed = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:nil];

        // Support both {"events": [...]} and plain [...]
        NSArray *eventsArray;
        if ([parsed isKindOfClass:[NSArray class]]) {
            eventsArray = parsed;
        } else if ([parsed isKindOfClass:[NSDictionary class]]) {
            eventsArray = parsed[@"events"];
        } else {
            return strdup("[]");
        }
        if (!eventsArray) return strdup("[]");

        // Find or create "Piko" calendar
        EKCalendar *targetCal = nil;
        for (EKCalendar *cal in [store calendarsForEntityType:EKEntityTypeEvent]) {
            if ([cal.title isEqualToString:PikoCalendarName]) {
                targetCal = cal;
                break;
            }
        }
        if (!targetCal) {
            targetCal = [EKCalendar calendarForEntityType:EKEntityTypeEvent
                                               eventStore:store];
            targetCal.title = PikoCalendarName;
            EKSource *source = store.defaultCalendarForNewEvents.source;
            if (!source) source = store.sources.firstObject;
            targetCal.source = source;
            if (source) {
                NSError *calError = nil;
                [store saveCalendar:targetCal commit:YES error:&calError];
                if (calError) {
                    targetCal = store.defaultCalendarForNewEvents;
                }
            }
        }
        if (!targetCal) return strdup("[]");

        NSMutableArray *result = [NSMutableArray array];

        for (NSDictionary *item in eventsArray) {
            if (![item isKindOfClass:[NSDictionary class]]) continue;

            NSString *localId = item[@"localId"] ?: @"";
            NSString *systemId = item[@"systemId"];
            NSString *title = item[@"title"] ?: @"";
            NSNumber *startAt = item[@"startAt"] ?: @0;
            NSNumber *endAt = item[@"endAt"] ?: @0;
            NSString *location = item[@"location"];
            NSString *description = item[@"description"];
            NSNumber *localModifiedAt = item[@"localModifiedAt"];

            // Ensure non-empty strings for EventKit
            if (![location isKindOfClass:[NSString class]]) location = nil;
            if (![description isKindOfClass:[NSString class]]) description = nil;

            EKEvent *event = nil;
            if (systemId.length > 0) {
                event = [store eventWithIdentifier:systemId];
            }
            if (!event) {
                event = [EKEvent eventWithEventStore:store];
            }

            event.calendar = targetCal;
            event.title = title;
            event.startDate = [NSDate dateWithTimeIntervalSince1970:[startAt longLongValue]];
            event.endDate = [NSDate dateWithTimeIntervalSince1970:[endAt longLongValue]];
            event.location = location;
            event.notes = description;

            NSError *error = nil;
            BOOL saved = [store saveEvent:event span:EKSpanThisEvent commit:YES error:&error];
            if (saved) {
                NSMutableDictionary *entry = [NSMutableDictionary dictionary];
                entry[@"localId"] = localId;
                entry[@"systemId"] = event.eventIdentifier ?: @"";
                if (localModifiedAt) {
                    entry[@"localModifiedAt"] = localModifiedAt;
                }
                [result addObject:entry];
            }
        }

        return piko_calendar_json(result);
        } @catch (NSException *exception) {
            return piko_calendar_error(exception.reason ?: exception.name);
        }
    }
}
