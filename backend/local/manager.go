package local

import (
	"context"
	"fmt"
	"sync"

	"github.com/google/uuid"
)

type session struct {
	mu     sync.Mutex
	write  func([]byte) error
	resize func(cols, rows int) error
	close  func() error
}

// Manager manages active local terminal sessions.
type Manager struct {
	ctx      context.Context
	mu       sync.RWMutex
	sessions map[string]*session
}

func NewManager(ctx context.Context) *Manager {
	return &Manager{
		ctx:      ctx,
		sessions: make(map[string]*session),
	}
}

// Connect spawns a local shell and returns a connID prefixed with "local-".
func (m *Manager) Connect(cols, rows int) (string, error) {
	connID := "local-" + uuid.NewString()
	sess, err := startSession(m.ctx, connID, cols, rows)
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	m.sessions[connID] = sess
	m.mu.Unlock()
	return connID, nil
}

// Has reports whether connID belongs to a local session.
func (m *Manager) Has(connID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.sessions[connID]
	return ok
}

func (m *Manager) Disconnect(connID string) error {
	m.mu.Lock()
	sess, ok := m.sessions[connID]
	if ok {
		delete(m.sessions, connID)
	}
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("local session %s not found", connID)
	}
	return sess.close()
}

func (m *Manager) SendInput(connID string, data []byte) error {
	m.mu.RLock()
	sess := m.sessions[connID]
	m.mu.RUnlock()
	if sess == nil {
		return fmt.Errorf("local session %s not found", connID)
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()
	return sess.write(data)
}

func (m *Manager) ResizeTerminal(connID string, cols, rows int) error {
	m.mu.RLock()
	sess := m.sessions[connID]
	m.mu.RUnlock()
	if sess == nil {
		return fmt.Errorf("local session %s not found", connID)
	}
	return sess.resize(cols, rows)
}

// CloseAll terminates all local sessions on app shutdown.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.sessions))
	for id := range m.sessions {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		_ = m.Disconnect(id)
	}
}
