package storage

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS sessions (
	id          TEXT PRIMARY KEY,
	label       TEXT    NOT NULL DEFAULT '',
	host        TEXT    NOT NULL,
	port        INTEGER NOT NULL DEFAULT 22,
	username    TEXT    NOT NULL,
	auth_type   TEXT    NOT NULL DEFAULT 'password',
	password    TEXT    NOT NULL DEFAULT '',
	key_path    TEXT    NOT NULL DEFAULT '',
	passphrase  TEXT    NOT NULL DEFAULT '',
	group_name  TEXT    NOT NULL DEFAULT '',
	keepalive   INTEGER NOT NULL DEFAULT 60,
	timeout     INTEGER NOT NULL DEFAULT 30,
	encoding    TEXT    NOT NULL DEFAULT 'UTF-8',
	jump_host       TEXT    NOT NULL DEFAULT '',
	jump_profile_id TEXT    NOT NULL DEFAULT '',
	init_command    TEXT    NOT NULL DEFAULT '',
	created_at  DATETIME NOT NULL,
	updated_at  DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_chat_sessions (
	id          TEXT PRIMARY KEY,
	target_id   TEXT    NOT NULL DEFAULT '',
	title       TEXT    NOT NULL DEFAULT '',
	auto_exec   INTEGER NOT NULL DEFAULT 0,
	created_at  DATETIME NOT NULL,
	updated_at  DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_chat_messages (
	id            TEXT PRIMARY KEY,
	session_id    TEXT    NOT NULL,
	role          TEXT    NOT NULL,
	content       TEXT    NOT NULL DEFAULT '',
	context_json  TEXT    NOT NULL DEFAULT '',
	tool_calls    TEXT    NOT NULL DEFAULT '',
	tool_call_id  TEXT    NOT NULL DEFAULT '',
	created_at    DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_session ON ai_chat_messages(session_id);

CREATE TABLE IF NOT EXISTS port_forwards (
	id           TEXT PRIMARY KEY,
	session_id   TEXT    NOT NULL DEFAULT '',
	type         TEXT    NOT NULL DEFAULT 'local',
	bind_addr    TEXT    NOT NULL DEFAULT '127.0.0.1',
	bind_port    INTEGER NOT NULL DEFAULT 0,
	target_host  TEXT    NOT NULL DEFAULT '',
	target_port  INTEGER NOT NULL DEFAULT 0,
	auto_start   INTEGER NOT NULL DEFAULT 0,
	enabled      INTEGER NOT NULL DEFAULT 1,
	created_at   DATETIME NOT NULL,
	updated_at   DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_port_forwards_session ON port_forwards(session_id);
`

type Store struct {
	db *sql.DB
}

func Open(dataDir string) (*Store, error) {
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	dbPath := filepath.Join(dataDir, "ishell.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	if err = configureSQLite(db); err != nil {
		_ = db.Close()
		return nil, err
	}
	if _, err = db.Exec(schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("init schema: %w", err)
	}
	st := &Store{db: db}
	if err = st.runMigrations(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrations: %w", err)
	}
	// Indexes on columns added by migrations must be created after
	// runMigrations, not in the schema block above — on an existing
	// database, CREATE TABLE IF NOT EXISTS is a no-op, so an index on a
	// migration-added column would fail with "no such column" until the
	// migration has actually run.
	if _, err = db.Exec(`CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_target ON ai_chat_sessions(target_id)`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("create index: %w", err)
	}
	return st, nil
}

func configureSQLite(db *sql.DB) error {
	pragmas := []string{
		"PRAGMA journal_mode = WAL",
		"PRAGMA busy_timeout = 5000",
		"PRAGMA synchronous = NORMAL",
	}
	for _, pragma := range pragmas {
		if _, err := db.Exec(pragma); err != nil {
			return fmt.Errorf("configure sqlite %q: %w", pragma, err)
		}
	}
	return nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) runMigrations() error {
	type col struct{ table, name, def string }
	migrations := []col{
		{"sessions", "jump_profile_id", "TEXT NOT NULL DEFAULT ''"},
		{"sessions", "forward_agent", "INTEGER NOT NULL DEFAULT 0"},
		{"ai_chat_sessions", "target_id", "TEXT NOT NULL DEFAULT ''"},
		{"ai_chat_sessions", "provider_id", "TEXT NOT NULL DEFAULT ''"},
		{"ai_chat_messages", "context_json", "TEXT NOT NULL DEFAULT ''"},
	}
	for _, m := range migrations {
		rows, err := s.db.Query(fmt.Sprintf("PRAGMA table_info(%s)", m.table))
		if err != nil {
			return err
		}
		exists := false
		for rows.Next() {
			var cid, notnull, pk int
			var name, typ string
			var dflt any
			if err := rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
				rows.Close()
				return err
			}
			if name == m.name {
				exists = true
				break
			}
		}
		rows.Close()
		if !exists {
			if _, err := s.db.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", m.table, m.name, m.def)); err != nil {
				return fmt.Errorf("add column %s.%s: %w", m.table, m.name, err)
			}
		}
	}
	return nil
}

// ── Sessions ──────────────────────────────────────────────────────────────────

func (s *Store) ListSessions() ([]Session, error) {
	rows, err := s.db.Query(`
		SELECT id, label, host, port, username, auth_type,
		       password, key_path, passphrase, group_name,
		       keepalive, timeout, encoding, jump_host, jump_profile_id, init_command, forward_agent,
		       created_at, updated_at
		FROM sessions ORDER BY group_name, label, host`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sessions []Session
	for rows.Next() {
		var sess Session
		err := rows.Scan(
			&sess.ID, &sess.Label, &sess.Host, &sess.Port,
			&sess.Username, &sess.AuthType,
			&sess.Password, &sess.KeyPath, &sess.Passphrase, &sess.Group,
			&sess.Keepalive, &sess.Timeout, &sess.Encoding,
			&sess.JumpHost, &sess.JumpProfileID, &sess.InitCommand, &sess.ForwardAgent,
			&sess.CreatedAt, &sess.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}
		sessions = append(sessions, sess)
	}
	return sessions, rows.Err()
}

func (s *Store) GetSession(id string) (*Session, error) {
	var sess Session
	err := s.db.QueryRow(`
		SELECT id, label, host, port, username, auth_type,
		       password, key_path, passphrase, group_name,
		       keepalive, timeout, encoding, jump_host, jump_profile_id, init_command, forward_agent,
		       created_at, updated_at
		FROM sessions WHERE id = ?`, id).Scan(
		&sess.ID, &sess.Label, &sess.Host, &sess.Port,
		&sess.Username, &sess.AuthType,
		&sess.Password, &sess.KeyPath, &sess.Passphrase, &sess.Group,
		&sess.Keepalive, &sess.Timeout, &sess.Encoding,
		&sess.JumpHost, &sess.JumpProfileID, &sess.InitCommand, &sess.ForwardAgent,
		&sess.CreatedAt, &sess.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &sess, nil
}

func (s *Store) SaveSession(sess Session) (*Session, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	if sess.ID == "" {
		sess.ID = uuid.NewString()
		sess.CreatedAt = now
	}
	sess.UpdatedAt = now
	if sess.Port == 0 {
		sess.Port = 22
	}
	if sess.Keepalive == 0 {
		sess.Keepalive = 60
	}
	if sess.Timeout == 0 {
		sess.Timeout = 30
	}
	if sess.Encoding == "" {
		sess.Encoding = "UTF-8"
	}

	_, err := s.db.Exec(`
		INSERT INTO sessions
			(id, label, host, port, username, auth_type, password, key_path,
			 passphrase, group_name, keepalive, timeout, encoding,
			 jump_host, jump_profile_id, init_command, forward_agent, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			label=excluded.label, host=excluded.host, port=excluded.port,
			username=excluded.username, auth_type=excluded.auth_type,
			password=excluded.password, key_path=excluded.key_path,
			passphrase=excluded.passphrase, group_name=excluded.group_name,
			keepalive=excluded.keepalive, timeout=excluded.timeout,
			encoding=excluded.encoding, jump_host=excluded.jump_host,
			jump_profile_id=excluded.jump_profile_id,
			init_command=excluded.init_command, forward_agent=excluded.forward_agent,
			updated_at=excluded.updated_at`,
		sess.ID, sess.Label, sess.Host, sess.Port, sess.Username,
		string(sess.AuthType), sess.Password, sess.KeyPath, sess.Passphrase,
		sess.Group, sess.Keepalive, sess.Timeout, sess.Encoding,
		sess.JumpHost, sess.JumpProfileID, sess.InitCommand, sess.ForwardAgent,
		sess.CreatedAt,
		sess.UpdatedAt,
	)
	return &sess, err
}

func (s *Store) DeleteSession(id string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE id = ?`, id)
	return err
}

// ── Settings ──────────────────────────────────────────────────────────────────

func (s *Store) LoadSettings() (*Settings, error) {
	row := s.db.QueryRow(`SELECT value FROM settings WHERE key = 'app'`)
	var raw string
	if err := row.Scan(&raw); err == sql.ErrNoRows {
		def := DefaultSettings()
		return &def, nil
	} else if err != nil {
		return nil, err
	}
	var st Settings
	if err := json.Unmarshal([]byte(raw), &st); err != nil {
		def := DefaultSettings()
		return &def, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &fields); err == nil {
		if _, ok := fields["show_quick_commands"]; !ok {
			st.ShowQuickCommands = true
		}
		// Pre-multi-provider settings stored a single ai_base_url/ai_api_key/
		// ai_model triple. Fold it into AIProviders[0] so existing users keep
		// their configured service after upgrading.
		if _, ok := fields["ai_providers"]; !ok {
			if migrated := migrateLegacyAIProvider(fields); migrated != nil {
				st.AIProviders = []AIProvider{*migrated}
			}
		}
	}
	if st.QuickCommands == nil {
		st.QuickCommands = []QuickCommand{}
	}
	if st.QuickCommandGroups == nil {
		st.QuickCommandGroups = []QuickCommandGroup{}
	}
	if st.AIProviders == nil {
		st.AIProviders = []AIProvider{}
	}
	if st.CustomToolCalls == nil {
		st.CustomToolCalls = []CustomToolCall{}
	}
	if st.Language == "" {
		st.Language = "auto"
	}
	return &st, nil
}

// migrateLegacyAIProvider reconstructs a single AIProvider from the
// pre-multi-provider ai_base_url/ai_api_key/ai_model fields, or returns nil
// if none of them were set (nothing to migrate).
func migrateLegacyAIProvider(fields map[string]json.RawMessage) *AIProvider {
	var baseURL, apiKey, model string
	_ = json.Unmarshal(fields["ai_base_url"], &baseURL)
	_ = json.Unmarshal(fields["ai_api_key"], &apiKey)
	_ = json.Unmarshal(fields["ai_model"], &model)
	if baseURL == "" && apiKey == "" && model == "" {
		return nil
	}
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	if model == "" {
		model = "gpt-4o-mini"
	}
	return &AIProvider{ID: uuid.NewString(), Name: "Default", BaseURL: baseURL, APIKey: apiKey, Model: model}
}

func (s *Store) SaveSettings(st Settings) error {
	b, err := json.Marshal(st)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`
		INSERT INTO settings (key, value) VALUES ('app', ?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value`, string(b))
	return err
}
