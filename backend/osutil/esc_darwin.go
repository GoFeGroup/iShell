//go:build darwin

package osutil

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework AppKit -framework WebKit

#import <Cocoa/Cocoa.h>
#import <AppKit/NSEvent.h>
#import <WebKit/WebKit.h>

static BOOL EscGuardDebugEnabled(void) {
    NSString *enabled = [[[NSProcessInfo processInfo] environment] objectForKey:@"ISHELL_ESC_GUARD_DEBUG"];
    return [enabled isEqualToString:@"1"];
}

static void DebugLogFullscreenState(NSString *label, NSWindow *win) {
    if (!EscGuardDebugEnabled()) { return; }
    if (win == nil) {
        NSLog(@"[EscGuard] %@ window=nil", label);
        return;
    }
    NSLog(@"[EscGuard] %@ window=%p styleMask=%lu isFullscreen=%d firstResponder=%@ contentView=%@",
          label,
          win,
          (unsigned long)win.styleMask,
          (int)((win.styleMask & NSWindowStyleMaskFullScreen) != 0),
          NSStringFromClass([[win firstResponder] class]),
          NSStringFromClass([[win contentView] class]));
}

static WKWebView *FindWKWebView(NSView *view) {
    if (view == nil) { return nil; }
    if ([view isKindOfClass:[WKWebView class]]) { return (WKWebView *)view; }
    for (NSView *subview in [view subviews]) {
        WKWebView *found = FindWKWebView(subview);
        if (found != nil) { return found; }
    }
    return nil;
}

static void DispatchEscToJavaScript(NSWindow *win) {
    WKWebView *webView = nil;
    NSResponder *r = [win firstResponder];
    if ([r isKindOfClass:[WKWebView class]]) {
        webView = (WKWebView *)r;
    }
    if (webView == nil) {
        webView = FindWKWebView([win contentView]);
    }
    if (webView == nil) {
        NSLog(@"[EscGuard] no WKWebView found for JS ESC dispatch");
        return;
    }

    NSString *script = @"window.dispatchEvent(new CustomEvent('ishell:nativeEsc'))";
    [webView evaluateJavaScript:script completionHandler:^(id result, NSError *error) {
        if (error != nil) {
            NSLog(@"[EscGuard] JS ESC dispatch failed: %@", error);
        } else if (EscGuardDebugEnabled()) {
            NSLog(@"[EscGuard] JS ESC dispatch completed");
        }
    }];
}

// InstallEscGuard intercepts ESC while in native macOS fullscreen and consumes
// the event so the macOS fullscreen controller never sees it (preventing
// involuntary fullscreen exit). It notifies JavaScript with a custom event so
// the frontend can send \x1b to the SSH session without re-entering AppKit's
// native keyDown path.
//
// WHY dispatch_async: Wails v2 calls OnStartup from a goroutine (not the main
// Cocoa thread). NSEvent.addLocalMonitorForEventsMatchingMask:handler: is
// documented to require the main thread. Calling it from a background thread
// silently does nothing, so dispatch_async(main_queue) fixes this.
//
// WHY this approach works where others failed:
//   - JS e.preventDefault()          — xterm returns false but never calls
//                                       preventDefault, so DOM event propagates
//   - capture-phase addEventListener — stopPropagation blocks ESC reaching SSH
//   - swizzle NSWindow.cancel:       — fullscreen controller bypasses cancel:
//   - CGEventTap kCGSessionEventTap  — requires Accessibility permission dialog
//   - addLocalMonitorForEventsMatchingMask: fires at NSApplication.sendEvent:
//     level before any window or fullscreen controller sees the event.
//     Returning nil consumes it completely.
void InstallEscGuard(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        static BOOL installed = NO;
        if (installed) return;
        installed = YES;

        if (EscGuardDebugEnabled()) {
            NSLog(@"[EscGuard] monitor installed on main thread");
        }

        NSNotificationCenter *center = [NSNotificationCenter defaultCenter];
        [center addObserverForName:NSWindowWillEnterFullScreenNotification
                            object:nil
                             queue:[NSOperationQueue mainQueue]
                        usingBlock:^(NSNotification *note) {
            DebugLogFullscreenState(@"will-enter-fullscreen", (NSWindow *)note.object);
        }];
        [center addObserverForName:NSWindowDidEnterFullScreenNotification
                            object:nil
                             queue:[NSOperationQueue mainQueue]
                        usingBlock:^(NSNotification *note) {
            DebugLogFullscreenState(@"did-enter-fullscreen", (NSWindow *)note.object);
        }];
        [center addObserverForName:NSWindowWillExitFullScreenNotification
                            object:nil
                             queue:[NSOperationQueue mainQueue]
                        usingBlock:^(NSNotification *note) {
            DebugLogFullscreenState(@"will-exit-fullscreen", (NSWindow *)note.object);
        }];
        [center addObserverForName:NSWindowDidExitFullScreenNotification
                            object:nil
                             queue:[NSOperationQueue mainQueue]
                        usingBlock:^(NSNotification *note) {
            DebugLogFullscreenState(@"did-exit-fullscreen", (NSWindow *)note.object);
        }];

        [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                              handler:^NSEvent *(NSEvent *event) {
            if (event.keyCode != 53) { return event; }   // 53 = ESC hardware keycode

            NSApplication *app = [NSApplication sharedApplication];
            NSWindow *win = [app keyWindow] ?: [app mainWindow];
            BOOL isFS = (win != nil) && ((win.styleMask & NSWindowStyleMaskFullScreen) != 0);

            if (EscGuardDebugEnabled()) {
                NSLog(@"[EscGuard] ESC keyDown event=%p keyCode=%hu modifiers=%lu repeat=%d characters=%@",
                      event,
                      event.keyCode,
                      (unsigned long)event.modifierFlags,
                      (int)event.isARepeat,
                      event.characters);
            }
            DebugLogFullscreenState(@"esc-before", win);

            if (!isFS) {
                return event;    // not in native fullscreen: pass through normally
            }

            DispatchEscToJavaScript(win);
            DebugLogFullscreenState(@"esc-after-js-dispatch", win);

            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(200 * NSEC_PER_MSEC)),
                           dispatch_get_main_queue(), ^{
                DebugLogFullscreenState(@"esc-after-200ms", win);
            });

            // Return nil: event consumed here — fullscreen controller never exits
            return nil;
        }];
    });
}
*/
import "C"

func InstallEscGuard() { C.InstallEscGuard() }
