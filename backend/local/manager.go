package local

import (
	"context"
	"fmt"
	"sync"

	"github.com/google/uuid"
	"ishell/backend/termout"
)

type session struct {
	ctx     context.Context
	cancel  context.CancelFunc
	inputCh chan []byte
	mu      sync.Mutex
	write   func([]byte) error
	resize  func(cols, rows int) error
	close   func() error
	err     error
	em      *termout.Emitter // raw output ring buffer, read by AI tool calls
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
	select {
	case <-sess.ctx.Done():
		return sess.ctx.Err()
	default:
	}
	buf := make([]byte, len(data))
	copy(buf, data)

	sess.mu.Lock()
	err := sess.err
	sess.mu.Unlock()
	if err != nil {
		return err
	}

	select {
	case sess.inputCh <- buf:
		return nil
	case <-sess.ctx.Done():
		return sess.ctx.Err()
	}
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

// Snapshot returns recent raw terminal output and its offset, for AI tool calls.
func (m *Manager) Snapshot(connID string) ([]byte, int64, error) {
	m.mu.RLock()
	sess := m.sessions[connID]
	m.mu.RUnlock()
	if sess == nil {
		return nil, 0, fmt.Errorf("local session %s not found", connID)
	}
	data, offset := sess.em.Snapshot()
	return data, offset, nil
}

// Since returns terminal output written after offset, for AI tool calls.
func (m *Manager) Since(connID string, offset int64) ([]byte, error) {
	m.mu.RLock()
	sess := m.sessions[connID]
	m.mu.RUnlock()
	if sess == nil {
		return nil, fmt.Errorf("local session %s not found", connID)
	}
	return sess.em.Since(offset), nil
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

func newSession(ctx context.Context, em *termout.Emitter, write func([]byte) error, resize func(cols, rows int) error, closeFn func() error) *session {
	sessCtx, cancel := context.WithCancel(ctx)
	sess := &session{
		ctx:     sessCtx,
		cancel:  cancel,
		inputCh: make(chan []byte, 256),
		write:   write,
		resize:  resize,
		em:      em,
		close: func() error {
			cancel()
			return closeFn()
		},
	}
	go sess.pumpInput()
	return sess
}

func (s *session) pumpInput() {
	for {
		select {
		case data := <-s.inputCh:
			if err := s.write(data); err != nil {
				s.mu.Lock()
				s.err = err
				s.mu.Unlock()
				return
			}
		case <-s.ctx.Done():
			return
		}
	}
}
