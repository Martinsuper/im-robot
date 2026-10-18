#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#import <AppKit/AppKit.h>
#import <os/log.h>
typedef void (*PikoOpen)(const char *);
typedef bool (*PikoAllowed)(const char *);
// Debug builds launched by LaunchServices otherwise lose stderr diagnostics.
void piko_soul_log_gate(const char *reason) {
    os_log_with_type(OS_LOG_DEFAULT, OS_LOG_TYPE_INFO, "[soul] dispatch gate: %{public}s", reason);
}
static PikoOpen open_message;
static PikoAllowed allowed_message;
static id<UNUserNotificationCenterDelegate> previous_delegate;
@interface PikoSoulNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end
@implementation PikoSoulNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center didReceiveNotificationResponse:(UNNotificationResponse *)response withCompletionHandler:(void (^)(void))completion {
    NSString *identity=response.notification.request.content.userInfo[@"pikoSoulMessage"];
    if (!identity && [previous_delegate respondsToSelector:@selector(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:)]) {
        [previous_delegate userNotificationCenter:center didReceiveNotificationResponse:response withCompletionHandler:completion]; return;
    }
    // Rust validates against SQLite and may show a window. Never block the
    // AppKit thread while a dispatcher holds the database and queries a window.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{
        if (identity && open_message && allowed_message && allowed_message(identity.UTF8String)) open_message(identity.UTF8String);
        completion();
    });
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center willPresentNotification:(UNNotification *)notification withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completion {
    NSString *identity=notification.request.content.userInfo[@"pikoSoulMessage"];
    if ([notification.request.content.userInfo[@"pikoSystemMessage"] boolValue]) {
        if (@available(macOS 11.0, *)) completion(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList | UNNotificationPresentationOptionSound);
        else completion(UNNotificationPresentationOptionAlert | UNNotificationPresentationOptionSound);
        return;
    }
    if (!identity && [previous_delegate respondsToSelector:@selector(userNotificationCenter:willPresentNotification:withCompletionHandler:)]) {
        [previous_delegate userNotificationCenter:center willPresentNotification:notification withCompletionHandler:completion]; return;
    }
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{
        BOOL allowed=identity && allowed_message && allowed_message(identity.UTF8String);
        completion(allowed ? UNNotificationPresentationOptionBanner : UNNotificationPresentationOptionNone);
    });
}
@end
static PikoSoulNotificationDelegate *delegate;
void piko_soul_notifications_init(PikoOpen open, PikoAllowed allowed) {
    open_message=open; allowed_message=allowed;
    dispatch_async(dispatch_get_main_queue(),^{
        @try { previous_delegate=UNUserNotificationCenter.currentNotificationCenter.delegate; delegate=[PikoSoulNotificationDelegate new]; UNUserNotificationCenter.currentNotificationCenter.delegate=delegate; }
        @catch(NSException *exception) { /* Unsupported host: remain silent. */ }
    });
}
void piko_soul_notify(const char *message_id,const char *title,const char *body) {
    NSString *identity=[NSString stringWithUTF8String:message_id];
    NSString *heading=[NSString stringWithUTF8String:title];
    NSString *text=[NSString stringWithUTF8String:body];
    if (!identity || !text || !heading) return;
    @try {
        UNUserNotificationCenter *center=UNUserNotificationCenter.currentNotificationCenter;
        [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings){
            if (settings.authorizationStatus!=UNAuthorizationStatusAuthorized && settings.authorizationStatus!=UNAuthorizationStatusProvisional) return;
            dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{
                if (!allowed_message || !allowed_message(identity.UTF8String)) return;
                UNMutableNotificationContent *content=[UNMutableNotificationContent new];
                content.title=heading; content.body=text;
                content.userInfo=@{@"pikoSoulMessage":identity};
                UNNotificationRequest *request=[UNNotificationRequest requestWithIdentifier:[@"piko-soul:" stringByAppendingString:identity] content:content trigger:nil];
                [center addNotificationRequest:request withCompletionHandler:^(NSError *error) { /* No retries, including permission denial. */ }];
            });
        }];
    } @catch(NSException *exception) { /* No retries. */ }
}
void piko_soul_remove_notifications(const char *active_json) {
    NSData *bytes=[[NSString stringWithUTF8String:active_json] dataUsingEncoding:NSUTF8StringEncoding];
    NSArray *active=[NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
    if (![active isKindOfClass:NSArray.class]) return;
    NSSet *identities=[NSSet setWithArray:active];
    dispatch_async(dispatch_get_main_queue(),^{
        @try {
            UNUserNotificationCenter *center=UNUserNotificationCenter.currentNotificationCenter;
            [center getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification *> *notifications){
                NSMutableArray *remove=[NSMutableArray new];
                for (UNNotification *notification in notifications) {
                    NSString *identity=notification.request.content.userInfo[@"pikoSoulMessage"];
                    if (identity && ![identities containsObject:identity]) [remove addObject:notification.request.identifier];
                }
                [center removeDeliveredNotificationsWithIdentifiers:remove];
            }];
            [center getPendingNotificationRequestsWithCompletionHandler:^(NSArray<UNNotificationRequest *> *requests){
                NSMutableArray *remove=[NSMutableArray new];
                for (UNNotificationRequest *request in requests) {
                    NSString *identity=request.content.userInfo[@"pikoSoulMessage"];
                    if (identity && ![identities containsObject:identity]) [remove addObject:request.identifier];
                }
                [center removePendingNotificationRequestsWithIdentifiers:remove];
            }];
        } @catch(NSException *exception) {}
    });
}
// Called only by the explicit settings button; dispatch never asks for permission.
void piko_soul_request_notification_permission(void (*completion)(bool)) {
    dispatch_async(dispatch_get_main_queue(),^{
        @try {
            [UNUserNotificationCenter.currentNotificationCenter requestAuthorizationWithOptions:(UNAuthorizationOptionAlert|UNAuthorizationOptionSound) completionHandler:^(BOOL granted,NSError *error){completion(granted && error==nil);}];
        } @catch(NSException *exception) { completion(false); }
    });
}

// Shared system notifications use UserNotifications, matching the application's
// actual bundle identity and authorization rather than the legacy desktop plugin.
typedef void (*PikoNotificationCompletion)(const char *, uintptr_t);
static void piko_notification_complete(PikoNotificationCompletion done, uintptr_t context, NSDictionary *value) {
    NSData *bytes = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    NSString *json = bytes ? [[NSString alloc] initWithData:bytes encoding:NSUTF8StringEncoding] : @"{\"ok\":false,\"error\":\"无法读取系统通知响应\"}";
    done(json.UTF8String, context);
}
static void piko_notification_error(PikoNotificationCompletion done, uintptr_t context, NSString *message) {
    os_log_error(OS_LOG_DEFAULT, "[notifications] %{public}@", message);
    piko_notification_complete(done, context, @{@"ok":@NO, @"error": message ?: @"系统通知失败"});
}
static NSDictionary *piko_notification_status_value(UNAuthorizationStatus status, UNNotificationSetting alerts, UNNotificationSetting sounds, UNAlertStyle alertStyle) {
    NSString *authorization=@"unknown";
    switch (status) {
        case UNAuthorizationStatusNotDetermined: authorization=@"notDetermined"; break;
        case UNAuthorizationStatusDenied: authorization=@"denied"; break;
        case UNAuthorizationStatusAuthorized: authorization=@"authorized"; break;
        case UNAuthorizationStatusProvisional: authorization=@"provisional"; break;
        default: break;
    }
    NSString *style=alertStyle == UNAlertStyleBanner ? @"banner" : alertStyle == UNAlertStyleAlert ? @"alert" : @"none";
    // C comparisons have type int: boxing @(a == b) serializes 0/1, not JSON booleans.
    return @{@"ok":@YES, @"platform":@"macos", @"authorization":authorization,
        @"alertsEnabled": alerts == UNNotificationSettingEnabled ? @YES : @NO,
        @"soundsEnabled": sounds == UNNotificationSettingEnabled ? @YES : @NO, @"alertStyle":style};
}
void piko_system_notification_status(PikoNotificationCompletion done, uintptr_t context) {
    @try {
        [UNUserNotificationCenter.currentNotificationCenter getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
            piko_notification_complete(done, context, piko_notification_status_value(settings.authorizationStatus, settings.alertSetting, settings.soundSetting, settings.alertStyle));
        }];
    } @catch (NSException *exception) { piko_notification_error(done, context, exception.reason); }
}
void piko_system_notify(const char *message_id, const char *title, const char *body, PikoNotificationCompletion done, uintptr_t context) {
    @try {
        NSString *identity=[NSString stringWithUTF8String:message_id];
        NSString *heading=[NSString stringWithUTF8String:title];
        NSString *text=[NSString stringWithUTF8String:body];
        UNUserNotificationCenter *center=UNUserNotificationCenter.currentNotificationCenter;
        [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
            if (settings.authorizationStatus != UNAuthorizationStatusAuthorized && settings.authorizationStatus != UNAuthorizationStatusProvisional) {
                piko_notification_error(done, context, @"Piko 未获系统通知授权，请在系统设置的通知中允许 Piko 通知。"); return;
            }
            UNMutableNotificationContent *content=[UNMutableNotificationContent new];
            content.title=heading; content.body=text; content.sound=UNNotificationSound.defaultSound;
            content.userInfo=@{@"pikoSystemMessage":@YES};
            UNNotificationRequest *request=[UNNotificationRequest requestWithIdentifier:identity content:content trigger:nil];
            [center addNotificationRequest:request withCompletionHandler:^(NSError *error) {
                if (error) { piko_notification_error(done, context, error.localizedDescription); return; }
                os_log_info(OS_LOG_DEFAULT, "[notifications] submitted %{public}@", identity);
                piko_notification_complete(done, context, @{@"ok":@YES});
            }];
        }];
    } @catch (NSException *exception) { piko_notification_error(done, context, exception.reason); }
}
