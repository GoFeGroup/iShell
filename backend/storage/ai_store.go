package storage

import (
	"database/sql"
	"time"

	"github.com/google/uuid"
)

// ── AI chat sessions ────────────────────────────────────────────────────────

// ListAIChatSessionsByTarget returns the chat sessions bound to targetID
// (an SSH Session.ID, or "__local__" for any local terminal), most recently
// updated first.
func (s *Store) ListAIChatSessionsByTarget(targetID string) ([]AIChatSession, error) {
	rows, err := s.db.Query(`
		SELECT id, target_id, title, auto_exec, created_at, updated_at
		FROM ai_chat_sessions WHERE target_id = ? ORDER BY updated_at DESC`, targetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sessions []AIChatSession
	for rows.Next() {
		var sess AIChatSession
		if err := rows.Scan(&sess.ID, &sess.TargetID, &sess.Title, &sess.AutoExec, &sess.CreatedAt, &sess.UpdatedAt); err != nil {
			return nil, err
		}
		sessions = append(sessions, sess)
	}
	return sessions, rows.Err()
}

func (s *Store) GetAIChatSession(id string) (*AIChatSession, error) {
	var sess AIChatSession
	err := s.db.QueryRow(`
		SELECT id, target_id, title, auto_exec, created_at, updated_at
		FROM ai_chat_sessions WHERE id = ?`, id).Scan(
		&sess.ID, &sess.TargetID, &sess.Title, &sess.AutoExec, &sess.CreatedAt, &sess.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &sess, nil
}

// SaveAIChatSession upserts a chat session by ID, assigning a new UUID and
// CreatedAt when ID is empty (mirrors Store.SaveSession). TargetID is set on
// creation and never changes afterwards.
func (s *Store) SaveAIChatSession(sess AIChatSession) (*AIChatSession, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	if sess.ID == "" {
		sess.ID = uuid.NewString()
		sess.CreatedAt = now
	}
	sess.UpdatedAt = now

	_, err := s.db.Exec(`
		INSERT INTO ai_chat_sessions (id, target_id, title, auto_exec, created_at, updated_at)
		VALUES (?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			title=excluded.title, auto_exec=excluded.auto_exec, updated_at=excluded.updated_at`,
		sess.ID, sess.TargetID, sess.Title, sess.AutoExec, sess.CreatedAt, sess.UpdatedAt)
	return &sess, err
}

// SetAIChatAutoExec flips the auto-execute flag without a full session
// round-trip, and bumps updated_at so the sidebar's recency ordering reflects
// the change.
func (s *Store) SetAIChatAutoExec(id string, autoExec bool) error {
	_, err := s.db.Exec(`
		UPDATE ai_chat_sessions SET auto_exec = ?, updated_at = ? WHERE id = ?`,
		autoExec, time.Now().UTC().Format(time.RFC3339), id)
	return err
}

// DeleteAIChatSession removes a chat session and all of its messages. No
// FK/cascade is configured in the schema, so both deletes are explicit.
func (s *Store) DeleteAIChatSession(id string) error {
	if err := s.DeleteAIChatMessages(id); err != nil {
		return err
	}
	_, err := s.db.Exec(`DELETE FROM ai_chat_sessions WHERE id = ?`, id)
	return err
}

// ── AI chat messages ────────────────────────────────────────────────────────

func (s *Store) ListAIChatMessages(sessionID string) ([]AIChatMessage, error) {
	rows, err := s.db.Query(`
		SELECT id, session_id, role, content, tool_calls, tool_call_id, created_at
		FROM ai_chat_messages WHERE session_id = ? ORDER BY created_at, id`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var messages []AIChatMessage
	for rows.Next() {
		var msg AIChatMessage
		if err := rows.Scan(&msg.ID, &msg.SessionID, &msg.Role, &msg.Content,
			&msg.ToolCalls, &msg.ToolCallID, &msg.CreatedAt); err != nil {
			return nil, err
		}
		messages = append(messages, msg)
	}
	return messages, rows.Err()
}

// AppendAIChatMessage inserts a new, immutable chat message, filling in
// ID/CreatedAt when empty.
func (s *Store) AppendAIChatMessage(msg AIChatMessage) (*AIChatMessage, error) {
	if msg.ID == "" {
		msg.ID = uuid.NewString()
	}
	if msg.CreatedAt == "" {
		msg.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	_, err := s.db.Exec(`
		INSERT INTO ai_chat_messages (id, session_id, role, content, tool_calls, tool_call_id, created_at)
		VALUES (?,?,?,?,?,?,?)`,
		msg.ID, msg.SessionID, msg.Role, msg.Content, msg.ToolCalls, msg.ToolCallID, msg.CreatedAt)
	return &msg, err
}

func (s *Store) DeleteAIChatMessages(sessionID string) error {
	_, err := s.db.Exec(`DELETE FROM ai_chat_messages WHERE session_id = ?`, sessionID)
	return err
}
