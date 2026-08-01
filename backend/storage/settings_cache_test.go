package storage

import (
	"testing"
)

// TestLoadSettingsReturnsIndependentCopies guards the settings cache against
// shared mutable state: a caller mutating the Settings it got back (including
// nested slices) must never affect what the next LoadSettings call returns.
func TestLoadSettingsReturnsIndependentCopies(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	seed := DefaultSettings()
	seed.Theme = "light"
	seed.QuickCommands = []QuickCommand{{ID: "q1", Label: "ls", Command: "ls -la"}}
	seed.QuickCommandGroups = []QuickCommandGroup{{ID: "g1", Name: "grp", Commands: []QuickCommand{{ID: "q2", Label: "df", Command: "df -h"}}}}
	seed.AIProviders = []AIProvider{{ID: "p1", Name: "prov", BaseURL: "https://x/v1", APIKey: "k", Model: "m"}}
	seed.CustomToolCalls = []CustomToolCall{{ID: "t1", Name: "tool", CommandTemplate: "echo {{x}}", Parameters: []ToolCallParam{{Name: "x"}}}}
	if err := st.SaveSettings(seed); err != nil {
		t.Fatal(err)
	}

	first, err := st.LoadSettings()
	if err != nil {
		t.Fatal(err)
	}
	first.Theme = "mutated"
	first.QuickCommands[0].Command = "rm -rf /"
	first.QuickCommandGroups[0].Commands[0].Command = "mutated"
	first.AIProviders[0].APIKey = "stolen"
	first.CustomToolCalls[0].Parameters[0].Name = "mutated"

	second, err := st.LoadSettings()
	if err != nil {
		t.Fatal(err)
	}
	if second.Theme != "light" {
		t.Errorf("Theme leaked mutation: %q", second.Theme)
	}
	if second.QuickCommands[0].Command != "ls -la" {
		t.Errorf("QuickCommands leaked mutation: %q", second.QuickCommands[0].Command)
	}
	if second.QuickCommandGroups[0].Commands[0].Command != "df -h" {
		t.Errorf("QuickCommandGroups leaked mutation: %q", second.QuickCommandGroups[0].Commands[0].Command)
	}
	if second.AIProviders[0].APIKey != "k" {
		t.Errorf("AIProviders leaked mutation: %q", second.AIProviders[0].APIKey)
	}
	if second.CustomToolCalls[0].Parameters[0].Name != "x" {
		t.Errorf("CustomToolCalls leaked mutation: %q", second.CustomToolCalls[0].Parameters[0].Name)
	}
}

// TestSaveSettingsRefreshesCache ensures LoadSettings observes a save made
// after the cache was populated.
func TestSaveSettingsRefreshesCache(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	if _, err := st.LoadSettings(); err != nil { // populate cache with defaults
		t.Fatal(err)
	}

	updated := DefaultSettings()
	updated.Theme = "light"
	updated.FontSize = 20
	if err := st.SaveSettings(updated); err != nil {
		t.Fatal(err)
	}

	got, err := st.LoadSettings()
	if err != nil {
		t.Fatal(err)
	}
	if got.Theme != "light" || got.FontSize != 20 {
		t.Errorf("cache not refreshed by save: theme=%q fontSize=%d", got.Theme, got.FontSize)
	}
	// Slices must still be non-nil after the cache round-trip — the frontend
	// relies on them marshalling as [] rather than null.
	if got.QuickCommands == nil || got.AIProviders == nil || got.CustomToolCalls == nil || got.QuickCommandGroups == nil {
		t.Error("cache round-trip turned a non-nil settings slice into nil")
	}
}
