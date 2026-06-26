package ai

import (
	"strings"
	"testing"

	"ishell/backend/storage"
)

func TestResolveQuickCommandByName(t *testing.T) {
	settings := quickCommandTestSettings()

	match, err := resolveQuickCommand(settings, "  status  ", "", "")
	if err != nil {
		t.Fatalf("resolve quick command: %v", err)
	}
	if match.command != "git status" || match.groupName != "Git" {
		t.Fatalf("match = %+v, want Git status command", match)
	}
}

func TestResolveQuickCommandByShortcutAndGroup(t *testing.T) {
	settings := quickCommandTestSettings()

	match, err := resolveQuickCommand(settings, "", "Control+2", "Shell")
	if err != nil {
		t.Fatalf("resolve quick command: %v", err)
	}
	if match.command != "pwd" {
		t.Fatalf("command = %q, want pwd", match.command)
	}
}

func TestResolveQuickCommandLegacyQuickCommands(t *testing.T) {
	settings := &storage.Settings{
		QuickCommands: []storage.QuickCommand{
			{Label: "Legacy", Command: "date"},
		},
	}

	match, err := resolveQuickCommand(settings, "legacy", "", "")
	if err != nil {
		t.Fatalf("resolve quick command: %v", err)
	}
	if match.command != "date" || match.groupName != "Default" {
		t.Fatalf("match = %+v, want legacy default command", match)
	}
}

func TestResolveQuickCommandAmbiguousWithoutGroup(t *testing.T) {
	settings := quickCommandTestSettings()

	_, err := resolveQuickCommand(settings, "", "^1", "")
	if err == nil {
		t.Fatal("expected ambiguity error")
	}
	if !strings.Contains(err.Error(), "ambiguous") || !strings.Contains(err.Error(), "Git") || !strings.Contains(err.Error(), "Shell") {
		t.Fatalf("error = %q, want ambiguous groups", err)
	}
}

func TestResolveQuickCommandNameAndShortcutConflict(t *testing.T) {
	settings := quickCommandTestSettings()

	_, err := resolveQuickCommand(settings, "status", "Ctrl+2", "Git")
	if err == nil {
		t.Fatal("expected conflict error")
	}
	if !strings.Contains(err.Error(), "refer to different commands") {
		t.Fatalf("error = %q, want conflict", err)
	}
}

func TestResolveQuickCommandRequiresNameOrShortcut(t *testing.T) {
	_, err := resolveQuickCommand(quickCommandTestSettings(), "", "", "")
	if err == nil {
		t.Fatal("expected missing selector error")
	}
}

func quickCommandTestSettings() *storage.Settings {
	return &storage.Settings{
		QuickCommandGroups: []storage.QuickCommandGroup{
			{
				Name: "Git",
				Commands: []storage.QuickCommand{
					{Label: "Status", Command: "git status"},
					{Label: "Log", Command: "git log --oneline"},
				},
			},
			{
				Name: "Shell",
				Commands: []storage.QuickCommand{
					{Label: "List", Command: "ls"},
					{Label: "Pwd", Command: "pwd"},
				},
			},
		},
	}
}
