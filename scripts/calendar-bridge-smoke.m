// Deterministic native regression checks; never reads or writes the user's calendars.
#import <objc/runtime.h>
#import "../src-tauri/src/calendar_bridge.m"

static NSArray *throw_calendar_exception(id self, SEL command, EKEntityType type) {
    @throw [NSException exceptionWithName:@"PikoCalendarTest" reason:@"simulated EventKit failure" userInfo:nil];
}

static EKAuthorizationStatus throw_authorization_exception(id self, SEL command, EKEntityType type) {
    @throw [NSException exceptionWithName:@"PikoCalendarTest" reason:@"simulated authorization failure" userInfo:nil];
}

static void expect_error(char *response) {
    NSCAssert(response != NULL, @"Bridge must return a valid string");
    NSData *data = [[NSString stringWithUTF8String:response] dataUsingEncoding:NSUTF8StringEncoding];
    id decoded = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    NSCAssert([decoded isKindOfClass:[NSDictionary class]], @"Expected an error envelope");
    NSCAssert([decoded[@"error"] isEqualToString:@"simulated EventKit failure"], @"Exception must be returned as an error");
    free(response);
}

int main(void) {
    @autoreleasepool {
        // This test executable has no app Info.plist: fail before requesting TCC access.
        char *permission = piko_calendar_request_access();
        NSCAssert(strcmp(permission, "missingUsageDescription") == 0, @"Missing usage text must not invoke the permission API");
        free(permission);
        NSDate *start = [NSDate dateWithTimeIntervalSince1970:1577836800];
        NSDate *end = [[NSCalendar currentCalendar] dateByAddingUnit:NSCalendarUnitYear value:12 toDate:start options:0];
        NSArray<NSArray<NSDate *> *> *windows = piko_calendar_windows(start, end);
        NSCAssert(windows.count == 12, @"Twelve years must not be sent as one EventKit query");
        NSDate *cursor = start;
        for (NSArray<NSDate *> *window in windows) {
            NSCAssert([window[0] isEqualToDate:cursor], @"Query windows must be contiguous");
            NSCAssert([window[1] timeIntervalSinceDate:window[0]] < 367 * 86400, @"Each query must fit EventKit's four-year limit");
            cursor = window[1];
        }
        NSCAssert([cursor isEqualToDate:end], @"The last query must include the requested future range");
        NSString *title = [@"中文日程🙂" stringByPaddingToLength:1000 withString:@"中文日程🙂" startingAtIndex:0];
        char *serialized = piko_calendar_json(@[@{@"title":title}]);
        NSData *data = [[NSString stringWithUTF8String:serialized] dataUsingEncoding:NSUTF8StringEncoding];
        NSArray *decoded = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        NSCAssert([decoded[0][@"title"] isEqualToString:title], @"Unicode must round-trip intact");
        free(serialized);
        Method authorization = class_getClassMethod([EKEventStore class], @selector(authorizationStatusForEntityType:));
        IMP originalAuthorization = method_setImplementation(authorization, (IMP)throw_authorization_exception);
        NSCAssert(strcmp(piko_calendar_auth_status(), "unavailable") == 0, @"Authorization exceptions must not cross the C ABI");
        method_setImplementation(authorization, originalAuthorization);
        Method method = class_getInstanceMethod([EKEventStore class], @selector(calendarsForEntityType:));
        IMP original = method_setImplementation(method, (IMP)throw_calendar_exception);
        expect_error(piko_calendar_pull());
        expect_error(piko_calendar_push("[]"));
        method_setImplementation(method, original);
        puts("Calendar bridge: permission preflight, Unicode and native exception checks passed");
    }
    return 0;
}
