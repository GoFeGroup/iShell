//go:build windows

package osutil

import (
	"syscall"
	"unsafe"
)

var (
	modUser32         = syscall.NewLazyDLL("user32.dll")
	procFindWindowW   = modUser32.NewProc("FindWindowW")
	procSetWindowPos  = modUser32.NewProc("SetWindowPos")
	procSetForeground = modUser32.NewProc("SetForegroundWindow")
	procSetFocus      = modUser32.NewProc("SetFocus")
)

const (
	hwndTopmost   = ^uintptr(0) // HWND_TOPMOST
	hwndNotopmost = ^uintptr(1) // HWND_NOTOPMOST
	swpNosize     = 0x0001
	swpNomove     = 0x0002
	swpShowwindow = 0x0040
)

// PlatformBringToFront forces the iShell window to the foreground using the
// HWND_TOPMOST trick, which bypasses Windows' foreground-steal restriction.
func PlatformBringToFront() {
	titlePtr, err := syscall.UTF16PtrFromString("iShell")
	if err != nil {
		return
	}
	hwnd, _, _ := procFindWindowW.Call(0, uintptr(unsafe.Pointer(titlePtr)))
	if hwnd == 0 {
		return
	}
	procSetWindowPos.Call(hwnd, hwndTopmost, 0, 0, 0, 0, swpNosize|swpNomove|swpShowwindow)
	procSetWindowPos.Call(hwnd, hwndNotopmost, 0, 0, 0, 0, swpNosize|swpNomove|swpShowwindow)
	procSetForeground.Call(hwnd)
	procSetFocus.Call(hwnd)
}
