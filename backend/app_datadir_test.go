package backend

import (
	"path/filepath"
	"runtime"
	"testing"
)

// TestDataDirHonorsAPPDATAOverrideOnEveryPlatform guards against a
// regression where dataDir() only consulted APPDATA on Windows. Tests
// throughout this package (see mcpserver_app_test.go) rely on
// t.Setenv("APPDATA", ...) to sandbox App.Startup away from the real user
// profile; if darwin/linux stop honoring that override, those tests silently
// read and write the developer's actual ~/Library/Application Support/iShell
// (or ~/.config/ishell) data instead of a temp directory.
func TestDataDirHonorsAPPDATAOverrideOnEveryPlatform(t *testing.T) {
	override := t.TempDir()
	t.Setenv("APPDATA", override)

	got := dataDir()
	want := filepath.Join(override, "iShell")
	if got != want {
		t.Fatalf("dataDir() with APPDATA set = %q, want %q (on GOOS=%s)", got, want, runtime.GOOS)
	}
}

// TestDataDirFallsBackToPlatformDefaultWithoutAPPDATA documents the
// production behavior when no override is present: darwin gets a fixed
// path under the user's home, other platforms fall back to XDG_CONFIG_HOME
// or ~/.config.
func TestDataDirFallsBackToPlatformDefaultWithoutAPPDATA(t *testing.T) {
	t.Setenv("APPDATA", "")
	t.Setenv("XDG_CONFIG_HOME", "")

	got := dataDir()
	if got == "" {
		t.Fatal("dataDir() returned an empty path")
	}
	if filepath.Base(got) != "iShell" && filepath.Base(got) != "ishell" {
		t.Fatalf("dataDir() = %q, want it to end in iShell/ishell", got)
	}
}
