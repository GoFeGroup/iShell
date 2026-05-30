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
	jump_host   TEXT    NOT NULL DEFAULT '',
	init_command TEXT   NOT NULL DEFAULT '',
	created_at  DATETIME NOT NULL,
	updated_at  DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
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
	if _, err = db.Exec(schema); err != nil {
		return nil, fmt.Errorf("init schema: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

// ── Sessions ──────────────────────────────────────────────────────────────────

func (s *Store) ListSessions() ([]Session, error) {
	rows, err := s.db.Query(`
		SELECT id, label, host, port, username, auth_type,
		       password, key_path, passphrase, group_name,
		       keepalive, timeout, encoding, jump_host, init_command,
		       created_at, updated_at
		FROM sessions ORDER BY group_name, label, host`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sessions []Session
	for rows.Next() {
		var sess Session
		var createdAt, updatedAt string
		err := rows.Scan(
			&sess.ID, &sess.Label, &sess.Host, &sess.Port,
			&sess.Username, &sess.AuthType,
			&sess.Password, &sess.KeyPath, &sess.Passphrase, &sess.Group,
			&sess.Keepalive, &sess.Timeout, &sess.Encoding,
			&sess.JumpHost, &sess.InitCommand,
			&createdAt, &updatedAt,
		)
		if err != nil {
			return nil, err
		}
		sess.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
		sess.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAt)
		sessions = append(sessions, sess)
	}
	return sessions, rows.Err()
}

func (s *Store) GetSession(id string) (*Session, error) {
	var sess Session
	var createdAt, updatedAt string
	err := s.db.QueryRow(`
		SELECT id, label, host, port, username, auth_type,
		       password, key_path, passphrase, group_name,
		       keepalive, timeout, encoding, jump_host, init_command,
		       created_at, updated_at
		FROM sessions WHERE id = ?`, id).Scan(
		&sess.ID, &sess.Label, &sess.Host, &sess.Port,
		&sess.Username, &sess.AuthType,
		&sess.Password, &sess.KeyPath, &sess.Passphrase, &sess.Group,
		&sess.Keepalive, &sess.Timeout, &sess.Encoding,
		&sess.JumpHost, &sess.InitCommand,
		&createdAt, &updatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	sess.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	sess.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAt)
	return &sess, nil
}

func (s *Store) SaveSession(sess Session) (*Session, error) {
	now := time.Now()
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
			 jump_host, init_command, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			label=excluded.label, host=excluded.host, port=excluded.port,
			username=excluded.username, auth_type=excluded.auth_type,
			password=excluded.password, key_path=excluded.key_path,
			passphrase=excluded.passphrase, group_name=excluded.group_name,
			keepalive=excluded.keepalive, timeout=excluded.timeout,
			encoding=excluded.encoding, jump_host=excluded.jump_host,
			init_command=excluded.init_command, updated_at=excluded.updated_at`,
		sess.ID, sess.Label, sess.Host, sess.Port, sess.Username,
		string(sess.AuthType), sess.Password, sess.KeyPath, sess.Passphrase,
		sess.Group, sess.Keepalive, sess.Timeout, sess.Encoding,
		sess.JumpHost, sess.InitCommand,
		sess.CreatedAt.Format(time.RFC3339),
		sess.UpdatedAt.Format(time.RFC3339),
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
	return &st, nil
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
