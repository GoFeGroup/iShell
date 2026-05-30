package ssh

import (
	"context"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pkg/sftp"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	"ishell/backend/storage"
	gossh "golang.org/x/crypto/ssh"
)

// Conn holds an active SSH connection and its sub-resources.
type Conn struct {
	ID        string
	SessionID string
	client    *gossh.Client
	term      *TermSession
	sftpCl    *sftp.Client
	mu        sync.Mutex
}

// Manager manages all active SSH connections.
type Manager struct {
	mu    sync.RWMutex
	conns map[string]*Conn
	ctx   context.Context
}

func NewManager(ctx context.Context) *Manager {
	return &Manager{ctx: ctx, conns: make(map[string]*Conn)}
}

// ── Connect ───────────────────────────────────────────────────────────────────

type ConnectOptions struct {
	Session    storage.Session
	Password   string // override password (from connect dialog)
	KeyPath    string // override key path
	Passphrase string // override passphrase
	KnownHostsPath string
	StrictHostKey  bool
	Cols, Rows int
}

type HostKeyError struct {
	Host        string
	Fingerprint string
	Key         gossh.PublicKey
}

func (e *HostKeyError) Error() string {
	return fmt.Sprintf("unknown host key for %s: %s", e.Host, gossh.FingerprintSHA256(e.Key))
}

func (m *Manager) Connect(opts ConnectOptions) (string, error) {
	sess := opts.Session
	host := fmt.Sprintf("%s:%d", sess.Host, sess.Port)

	// ── Auth methods ──────────────────────────────────────────────────────────
	var authMethods []gossh.AuthMethod

	authType := sess.AuthType
	if opts.Password != "" || authType == storage.AuthPassword {
		pw := opts.Password
		if pw == "" {
			pw = sess.Password
		}
		authMethods = append(authMethods, gossh.Password(pw))
	}

	keyPath := opts.KeyPath
	if keyPath == "" {
		keyPath = sess.KeyPath
	}
	passphrase := opts.Passphrase
	if passphrase == "" {
		passphrase = sess.Passphrase
	}
	if keyPath != "" || authType == storage.AuthKey {
		if keyPath != "" {
			signer, err := LoadPrivateKey(keyPath, passphrase)
			if err != nil {
				return "", fmt.Errorf("load private key: %w", err)
			}
			authMethods = append(authMethods, gossh.PublicKeys(signer))
		}
	}

	if len(authMethods) == 0 {
		// Fallback: keyboard-interactive (prompts will not appear in GUI, but avoids hard fail)
		authMethods = append(authMethods, gossh.KeyboardInteractive(func(_, _ string, qs []string, _ []bool) ([]string, error) {
			return make([]string, len(qs)), nil
		}))
	}

	// ── Host key callback ─────────────────────────────────────────────────────
	var hkCallback gossh.HostKeyCallback
	if !opts.StrictHostKey {
		hkCallback = gossh.InsecureIgnoreHostKey()
	} else {
		cb, err := HostKeyCallback(opts.KnownHostsPath)
		if err != nil {
			return "", fmt.Errorf("known_hosts: %w", err)
		}
		// Wrap to emit an event on unknown host so the frontend can prompt
		hkCallback = func(hostname string, remote net.Addr, key gossh.PublicKey) error {
			err := cb(hostname, remote, key)
			if err != nil {
				fp := gossh.FingerprintSHA256(key)
				runtime.EventsEmit(m.ctx, "ssh:unknown_host", map[string]string{
					"hostname":    hostname,
					"fingerprint": fp,
					"key_type":    key.Type(),
				})
				return err
			}
			return nil
		}
	}

	// ── Dial ─────────────────────────────────────────────────────────────────
	timeout := time.Duration(sess.Timeout) * time.Second
	if timeout == 0 {
		timeout = 30 * time.Second
	}

	cfg := &gossh.ClientConfig{
		User:            sess.Username,
		Auth:            authMethods,
		HostKeyCallback: hkCallback,
		Timeout:         timeout,
	}

	client, err := gossh.Dial("tcp", host, cfg)
	if err != nil {
		return "", fmt.Errorf("dial %s: %w", host, err)
	}

	// ── Start keepalive ───────────────────────────────────────────────────────
	if sess.Keepalive > 0 {
		go func() {
			ticker := time.NewTicker(time.Duration(sess.Keepalive) * time.Second)
			defer ticker.Stop()
			for range ticker.C {
				_, _, err := client.SendRequest("keepalive@openssh.com", true, nil)
				if err != nil {
					return
				}
			}
		}()
	}

	// ── Open PTY session ──────────────────────────────────────────────────────
	connID := uuid.NewString()
	term, err := newTermSession(m.ctx, connID, client, opts.Cols, opts.Rows)
	if err != nil {
		client.Close()
		return "", fmt.Errorf("open pty: %w", err)
	}

	conn := &Conn{
		ID:        connID,
		SessionID: sess.ID,
		client:    client,
		term:      term,
	}
	m.mu.Lock()
	m.conns[connID] = conn
	m.mu.Unlock()

	// Send initial command if configured
	if sess.InitCommand != "" {
		_ = term.Write([]byte(sess.InitCommand + "\n"))
	}

	return connID, nil
}

// ── Disconnect ────────────────────────────────────────────────────────────────

func (m *Manager) Disconnect(connID string) error {
	m.mu.Lock()
	conn, ok := m.conns[connID]
	if ok {
		delete(m.conns, connID)
	}
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("connection %s not found", connID)
	}
	conn.mu.Lock()
	defer conn.mu.Unlock()
	if conn.term != nil {
		conn.term.Close()
	}
	if conn.sftpCl != nil {
		conn.sftpCl.Close()
	}
	return conn.client.Close()
}

// ── Terminal ──────────────────────────────────────────────────────────────────

func (m *Manager) SendInput(connID string, data []byte) error {
	conn := m.get(connID)
	if conn == nil {
		return fmt.Errorf("connection %s not found", connID)
	}
	return conn.term.Write(data)
}

func (m *Manager) ResizeTerminal(connID string, cols, rows int) error {
	conn := m.get(connID)
	if conn == nil {
		return fmt.Errorf("connection %s not found", connID)
	}
	return conn.term.Resize(cols, rows)
}

// ── SFTP ──────────────────────────────────────────────────────────────────────

// SFTPClient lazily creates and returns the SFTP client for a connection.
func (m *Manager) SFTPClient(connID string) (*sftp.Client, error) {
	conn := m.get(connID)
	if conn == nil {
		return nil, fmt.Errorf("connection %s not found", connID)
	}
	conn.mu.Lock()
	defer conn.mu.Unlock()
	if conn.sftpCl != nil {
		return conn.sftpCl, nil
	}
	cl, err := sftp.NewClient(conn.client)
	if err != nil {
		return nil, fmt.Errorf("open sftp: %w", err)
	}
	conn.sftpCl = cl
	return cl, nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func (m *Manager) get(connID string) *Conn {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.conns[connID]
}

// ListActive returns a map of connID → sessionID for all live connections.
func (m *Manager) ListActive() map[string]string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make(map[string]string, len(m.conns))
	for id, c := range m.conns {
		out[id] = c.SessionID
	}
	return out
}

// CloseAll disconnects every active connection (called on app shutdown).
func (m *Manager) CloseAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.conns))
	for id := range m.conns {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		_ = m.Disconnect(id)
	}
}
