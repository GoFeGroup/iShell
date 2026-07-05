package storage

import (
	"database/sql"
	"time"

	"github.com/google/uuid"
)

// ── Port forwards ─────────────────────────────────────────────────────────────

func (s *Store) ListPortForwardsForSession(sessionID string) ([]PortForward, error) {
	rows, err := s.db.Query(`
		SELECT id, session_id, type, bind_addr, bind_port, target_host, target_port,
		       auto_start, enabled, created_at, updated_at
		FROM port_forwards WHERE session_id = ? ORDER BY created_at`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var forwards []PortForward
	for rows.Next() {
		var pf PortForward
		if err := rows.Scan(&pf.ID, &pf.SessionID, &pf.Type, &pf.BindAddr, &pf.BindPort,
			&pf.TargetHost, &pf.TargetPort, &pf.AutoStart, &pf.Enabled, &pf.CreatedAt, &pf.UpdatedAt); err != nil {
			return nil, err
		}
		forwards = append(forwards, pf)
	}
	return forwards, rows.Err()
}

func (s *Store) GetPortForward(id string) (*PortForward, error) {
	var pf PortForward
	err := s.db.QueryRow(`
		SELECT id, session_id, type, bind_addr, bind_port, target_host, target_port,
		       auto_start, enabled, created_at, updated_at
		FROM port_forwards WHERE id = ?`, id).Scan(
		&pf.ID, &pf.SessionID, &pf.Type, &pf.BindAddr, &pf.BindPort,
		&pf.TargetHost, &pf.TargetPort, &pf.AutoStart, &pf.Enabled, &pf.CreatedAt, &pf.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &pf, nil
}

// SavePortForward upserts a rule by ID, assigning a new UUID and CreatedAt
// when ID is empty (mirrors Store.SaveSession).
func (s *Store) SavePortForward(pf PortForward) (*PortForward, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	if pf.ID == "" {
		pf.ID = uuid.NewString()
		pf.CreatedAt = now
	}
	pf.UpdatedAt = now
	if pf.BindAddr == "" {
		pf.BindAddr = "127.0.0.1"
	}

	_, err := s.db.Exec(`
		INSERT INTO port_forwards
			(id, session_id, type, bind_addr, bind_port, target_host, target_port,
			 auto_start, enabled, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			session_id=excluded.session_id, type=excluded.type, bind_addr=excluded.bind_addr,
			bind_port=excluded.bind_port, target_host=excluded.target_host, target_port=excluded.target_port,
			auto_start=excluded.auto_start, enabled=excluded.enabled, updated_at=excluded.updated_at`,
		pf.ID, pf.SessionID, string(pf.Type), pf.BindAddr, pf.BindPort, pf.TargetHost, pf.TargetPort,
		pf.AutoStart, pf.Enabled, pf.CreatedAt, pf.UpdatedAt)
	return &pf, err
}

func (s *Store) DeletePortForward(id string) error {
	_, err := s.db.Exec(`DELETE FROM port_forwards WHERE id = ?`, id)
	return err
}
