// AVFoundation microphone authorization bridge.
// CoreAudio 直接打开输入设备在部分 macOS 版本不会触发 TCC 授权弹窗；
// 显式走 AVCaptureDevice 的授权流程才能保证用户看到请求。
#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

// 0 = notDetermined, 1 = restricted, 2 = denied, 3 = authorized
int piko_mic_authorization_status(void) {
    return (int)[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
}

void piko_mic_request_access(void (*callback)(int granted, void *context), void *context) {
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                             completionHandler:^(BOOL granted) {
        if (callback) callback(granted ? 1 : 0, context);
    }];
}
