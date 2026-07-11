package storage

import (
	"encoding/json"
	"testing"
)

// TestLoadSettingsMigratesLegacyAIFields guards against a regression in the
// AIProviders rollout: settings saved before that change have a single
// ai_base_url/ai_api_key/ai_model triple instead of ai_providers, and
// LoadSettings must fold that triple into AIProviders[0] rather than
// silently dropping the user's configured model service.
func TestLoadSettingsMigratesLegacyAIFields(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	legacy := map[string]any{
		"ai_enabled":  true,
		"ai_api_key":  "sk-legacy",
		"ai_base_url": "https://legacy.example.com/v1",
		"ai_model":    "legacy-model",
	}
	raw, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.db.Exec(`INSERT INTO settings (key, value) VALUES ('app', ?)`, string(raw)); err != nil {
		t.Fatal(err)
	}

	got, err := st.LoadSettings()
	if err != nil {
		t.Fatalf("load settings: %v", err)
	}
	if len(got.AIProviders) != 1 {
		t.Fatalf("want 1 migrated provider, got %d: %+v", len(got.AIProviders), got.AIProviders)
	}
	p := got.AIProviders[0]
	if p.ID == "" {
		t.Error("migrated provider is missing an ID")
	}
	if p.APIKey != "sk-legacy" || p.BaseURL != "https://legacy.example.com/v1" || p.Model != "legacy-model" {
		t.Errorf("migrated provider fields wrong: %+v", p)
	}
}

// TestLoadSettingsSkipsMigrationWhenAIProvidersPresent guards against the
// legacy-field migration clobbering settings that already have ai_providers,
// even if the old ai_base_url/ai_api_key/ai_model fields are still present
// (e.g. left over from an export/import round trip of an old backup).
func TestLoadSettingsSkipsMigrationWhenAIProvidersPresent(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	raw := map[string]any{
		"ai_enabled": true,
		"ai_api_key": "sk-legacy",
		"ai_providers": []AIProvider{
			{ID: "p1", Name: "Current", BaseURL: "https://current.example.com/v1", APIKey: "sk-current", Model: "current-model"},
		},
	}
	b, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.db.Exec(`INSERT INTO settings (key, value) VALUES ('app', ?)`, string(b)); err != nil {
		t.Fatal(err)
	}

	got, err := st.LoadSettings()
	if err != nil {
		t.Fatalf("load settings: %v", err)
	}
	if len(got.AIProviders) != 1 || got.AIProviders[0].ID != "p1" {
		t.Fatalf("existing ai_providers should be left untouched, got %+v", got.AIProviders)
	}
}
