package ssh

import (
	"context"
	"testing"

	"ishell/backend/storage"
)

func TestStartForwardRejectsDuplicateIDWithoutReplacingHandle(t *testing.T) {
	conn := &Conn{forwards: make(map[string]*forwardHandle)}
	m := &Manager{
		ctx:   context.Background(),
		conns: map[string]*Conn{"conn": conn},
	}
	rule := storage.PortForward{
		ID:         "duplicate",
		Type:       storage.ForwardLocal,
		BindAddr:   "127.0.0.1",
		BindPort:   0,
		TargetHost: "example.com",
		TargetPort: 22,
	}
	if _, err := m.StartForward("conn", rule); err != nil {
		t.Fatalf("first StartForward: %v", err)
	}
	defer m.StopForward("conn", rule.ID)

	conn.forwardsMu.Lock()
	original := conn.forwards[rule.ID]
	conn.forwardsMu.Unlock()
	if _, err := m.StartForward("conn", rule); err == nil {
		t.Fatal("duplicate StartForward returned nil error")
	}
	conn.forwardsMu.Lock()
	current := conn.forwards[rule.ID]
	conn.forwardsMu.Unlock()
	if current != original {
		t.Fatal("duplicate StartForward replaced the original handle")
	}
}
