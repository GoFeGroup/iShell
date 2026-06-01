//go:build !windows

package local

import (
	"runtime"
	"testing"
)

func TestDefaultShellUsesShellEnv(t *testing.T) {
	t.Setenv("SHELL", "/opt/homebrew/bin/fish")

	if got := defaultShell(); got != "/opt/homebrew/bin/fish" {
		t.Fatalf("defaultShell() = %q, want SHELL value", got)
	}
}

func TestShellCommandUsesLoginArgvOnMacOS(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("login argv behavior is only enabled on macOS")
	}

	cmd := shellCommand("/bin/zsh")
	if len(cmd.Args) != 1 || cmd.Args[0] != "-zsh" {
		t.Fatalf("cmd.Args = %#v, want [-zsh]", cmd.Args)
	}
}
