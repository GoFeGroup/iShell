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
	gossh "golang.org/x/crypto/ssh"
	"ishell/backend/storage"
)

// Conn holds an active SSH connection and its sub-resources.
type Conn struct {
	ID         string
	SessionID  string
	client     *gossh.Client
	jumpClient *gossh.Client
	term       *TermSession
	sftpCl     *sftp.Client
	mu         sync.Mutex
}

// Manager manages all active SSH connections.
type Manager struct {
	mu          sync.RWMutex
	conns       map[string]*Conn
	ctx         context.Context
	pendingMu   sync.Mutex
	pendingKeys map[string]gossh.PublicKey // hostname:port → key awaiting acceptance
}

func NewManager(ctx context.Context) *Manager {
	return &Manager{
		ctx:         ctx,
		conns:       make(map[string]*Conn),
		pendingKeys: make(map[string]gossh.PublicKey),
	}
}

// ── Connect ───────────────────────────────────────────────────────────────────

type ConnectOptions struct {
	Session        storage.Session
	JumpSession    *storage.Session // nil = direct connection
	Password       string           // override password (from connect dialog)
	KeyPath        string           // override key path
	Passphrase     string           // override passphrase
	KnownHostsPath string
	StrictHostKey  bool
	Cols, Rows     int
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
	pw := opts.Password
	if pw == "" {
		pw = sess.Password
	}
	if pw != "" {
		authMethods = append(authMethods, gossh.Password(pw))
	}

	keyPath := opts.KeyPath
	if keyPath == "" {
		keyPath = sess.KeyPath
	}
	if keyPath == "" && pw == "" {
		keyPath = DefaultPrivateKeyPath
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
				m.pendingMu.Lock()
				m.pendingKeys[hostname] = key
				m.pendingMu.Unlock()
				runtime.EventsEmit(m.ctx, "ssh:unknown_host", map[string]string{
					"hostname":    hostname,
					"fingerprint": fp,
					"key_type":    key.Type(),
					"session_id":  sess.ID,
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

	var client *gossh.Client
	var jumpClient *gossh.Client

	if opts.JumpSession != nil {
		j := opts.JumpSession
		var jumpAuth []gossh.AuthMethod
		jumpPW := j.Password
		if jumpPW != "" {
			jumpAuth = append(jumpAuth, gossh.Password(jumpPW))
		}
		if j.KeyPath != "" {
			signer, err := LoadPrivateKey(j.KeyPath, j.Passphrase)
			if err != nil {
				return "", fmt.Errorf("load jump host key: %w", err)
			}
			jumpAuth = append(jumpAuth, gossh.PublicKeys(signer))
		}
		if len(jumpAuth) == 0 {
			jumpAuth = append(jumpAuth, gossh.KeyboardInteractive(func(_, _ string, qs []string, _ []bool) ([]string, error) {
				return make([]string, len(qs)), nil
			}))
		}
		jumpUser := j.Username
		if jumpUser == "" {
			jumpUser = "root"
		}
		jumpPort := j.Port
		if jumpPort == 0 {
			jumpPort = 22
		}
		jumpAddr := fmt.Sprintf("%s:%d", j.Host, jumpPort)
		jumpCfg := &gossh.ClientConfig{
			User:            jumpUser,
			Auth:            jumpAuth,
			HostKeyCallback: hkCallback,
			Timeout:         timeout,
		}
		var err error
		jumpClient, err = gossh.Dial("tcp", jumpAddr, jumpCfg)
		if err != nil {
			return "", fmt.Errorf("dial jump host %s: %w", jumpAddr, err)
		}
		tunnelConn, err := jumpClient.Dial("tcp", host)
		if err != nil {
			jumpClient.Close()
			return "", fmt.Errorf("tunnel to %s via jump host: %w", host, err)
		}
		ncc, chans, reqs, err := gossh.NewClientConn(tunnelConn, host, cfg)
		if err != nil {
			tunnelConn.Close()
			jumpClient.Close()
			return "", fmt.Errorf("ssh handshake with %s: %w", host, err)
		}
		client = gossh.NewClient(ncc, chans, reqs)
	} else {
		var err error
		client, err = gossh.Dial("tcp", host, cfg)
		if err != nil {
			return "", fmt.Errorf("dial %s: %w", host, err)
		}
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
		ID:         connID,
		SessionID:  sess.ID,
		client:     client,
		jumpClient: jumpClient,
		term:       term,
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
	err := conn.client.Close()
	if conn.jumpClient != nil {
		conn.jumpClient.Close()
	}
	return err
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

// Snapshot returns recent raw terminal output and its offset, for AI tool calls.
func (m *Manager) Snapshot(connID string) ([]byte, int64, error) {
	conn := m.get(connID)
	if conn == nil {
		return nil, 0, fmt.Errorf("connection %s not found", connID)
	}
	data, offset := conn.term.Snapshot()
	return data, offset, nil
}

// Since returns terminal output written after offset, for AI tool calls.
func (m *Manager) Since(connID string, offset int64) ([]byte, error) {
	conn := m.get(connID)
	if conn == nil {
		return nil, fmt.Errorf("connection %s not found", connID)
	}
	return conn.term.Since(offset), nil
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

// AcceptAndStoreHostKey writes a previously seen unknown key to known_hosts.
func (m *Manager) AcceptAndStoreHostKey(hostname, khPath string) error {
	m.pendingMu.Lock()
	key, ok := m.pendingKeys[hostname]
	delete(m.pendingKeys, hostname)
	m.pendingMu.Unlock()
	if !ok {
		return fmt.Errorf("no pending host key for %s", hostname)
	}
	return AddHostKey(khPath, hostname, key)
}

// RemotePWD returns the default directory of the SFTP session (user home on most servers).
// It reuses the already-established SFTP client rather than opening a new exec channel.
func (m *Manager) RemotePWD(connID string) (string, error) {
	cl, err := m.SFTPClient(connID)
	if err != nil {
		return "/", err
	}
	return cl.Getwd()
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
