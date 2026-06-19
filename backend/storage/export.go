package storage

import (
	"fmt"
	"time"

	"gopkg.in/yaml.v3"
)

// ExportFormatVersion identifies the schema of the YAML export so future
// versions of iShell can detect and migrate older backups.
const ExportFormatVersion = "1"

// ExportData is the root document written to / read from the YAML backup file.
type ExportData struct {
	Version    string    `yaml:"version"`
	ExportedAt string    `yaml:"exported_at"`
	Settings   Settings  `yaml:"settings"`
	Sessions   []Session `yaml:"sessions"`
}

// ImportResult summarizes what ImportAll restored, for display in the UI.
type ImportResult struct {
	SessionCount int `json:"session_count"`
}

// ExportAll serializes every session and the app settings into a single YAML
// document. yaml.v3 quotes any scalar containing characters with special
// meaning in YAML (colons, '#', leading/trailing whitespace, quotes,
// backslashes, etc.), so passwords and passphrases round-trip correctly
// regardless of their content.
func (s *Store) ExportAll() ([]byte, error) {
	sessions, err := s.ListSessions()
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	if sessions == nil {
		sessions = []Session{}
	}
	settings, err := s.LoadSettings()
	if err != nil {
		return nil, fmt.Errorf("load settings: %w", err)
	}

	out, err := yaml.Marshal(ExportData{
		Version:    ExportFormatVersion,
		ExportedAt: time.Now().UTC().Format(time.RFC3339),
		Settings:   *settings,
		Sessions:   sessions,
	})
	if err != nil {
		return nil, fmt.Errorf("marshal yaml: %w", err)
	}
	return out, nil
}

// ImportAll parses a YAML document produced by ExportAll and restores its
// sessions (upserted by ID — re-importing the same file is idempotent) and
// settings into the store.
func (s *Store) ImportAll(data []byte) (*ImportResult, error) {
	var parsed ExportData
	if err := yaml.Unmarshal(data, &parsed); err != nil {
		return nil, fmt.Errorf("parse yaml: %w", err)
	}
	if parsed.Version == "" {
		return nil, fmt.Errorf("not a valid iShell config export (missing version field)")
	}

	now := time.Now().UTC().Format(time.RFC3339)
	for _, sess := range parsed.Sessions {
		if sess.Host == "" || sess.Username == "" {
			continue // skip malformed entries rather than failing the whole import
		}
		if sess.CreatedAt == "" {
			sess.CreatedAt = now
		}
		if _, err := s.SaveSession(sess); err != nil {
			return nil, fmt.Errorf("restore session %q: %w", sess.Label, err)
		}
	}

	if err := s.SaveSettings(parsed.Settings); err != nil {
		return nil, fmt.Errorf("restore settings: %w", err)
	}

	return &ImportResult{SessionCount: len(parsed.Sessions)}, nil
}
