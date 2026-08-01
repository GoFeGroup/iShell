package ssh

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pkg/sftp"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	gossh "golang.org/x/crypto/ssh"
	sshagent "golang.org/x/crypto/ssh/agent"
	"ishell/backend/storage"
)

// Conn holds an active SSH connection and its sub-resources.
type Conn struct {
	ID            string
	SessionID     string
	client        *gossh.Client
	jumpClient    *gossh.Client
	term          *TermSession
	sftpCl        *sftp.Client
	mu            sync.Mutex
	stopKeepalive chan struct{}
	forwardsMu    sync.Mutex
	forwards      map[string]*forwardHandle
	sshAgent      sshagent.Agent
	agentCloser   io.Closer
	// jumpAgentCloser is the agent connection dialed for jump-host auth (when
	// the jump profile uses AuthAgent); closed on Disconnect like agentCloser.
	jumpAgentCloser io.Closer
}

// Manager manages all active SSH connections.
type Manager struct {
	mu          sync.RWMutex
	conns       map[string]*Conn
	ctx         context.Context
	store       *storage.Store
	pendingMu sync.Mutex
	// pendingKeys holds host keys awaiting user acceptance, keyed by the exact
	// hostname string the HostKeyCallback received (the dial address, i.e.
	// "host:port"). The "ssh:unknown_host" event carries this same string and
	// the frontend passes it back verbatim to AcceptHostKey, so the two sides
	// agree by construction. A reconnect to the same host simply overwrites
	// the previous pending entry.
	pendingKeys map[string]gossh.PublicKey
}

func NewManager(ctx context.Context, store *storage.Store) *Manager {
	return &Manager{
		ctx:         ctx,
		conns:       make(map[string]*Conn),
		store:       store,
		pendingKeys: make(map[string]gossh.PublicKey),
	}
}

// ── Connect ───────────────────────────────────────────────────────────────────

type ConnectOptions struct {
	Session         storage.Session
	JumpSession     *storage.Session // nil = direct connection
	Password        string           // override password (from connect dialog)
	KeyPath         string           // override key path
	Passphrase      string           // override passphrase
	KnownHostsPath  string
	StrictHostKey   bool
	SkipHostKeyHost string
	Cols, Rows      int
}

type HostKeyError struct {
	Host        string
	Fingerprint string
	Key         gossh.PublicKey
}

func (e *HostKeyError) Error() string {
	return fmt.Sprintf("unknown host key for %s: %s", e.Host, gossh.FingerprintSHA256(e.Key))
}

// buildAuthMethods assembles the SSH auth methods for sess, with optional
// override credentials from the connect dialog ("" means use the stored
// value): password if present, private key (falling back to the default key
// when nothing else is configured), the SSH agent for AuthAgent sessions, and
// a no-op keyboard-interactive fallback when nothing matched. When agent auth
// is used, the returned agent/closer are non-nil and the caller owns closing
// the closer.
func buildAuthMethods(sess *storage.Session, pwOverride, keyPathOverride, passphraseOverride string) ([]gossh.AuthMethod, sshagent.Agent, io.Closer, error) {
	var methods []gossh.AuthMethod

	pw := pwOverride
	if pw == "" {
		pw = sess.Password
	}
	if pw != "" {
		methods = append(methods, gossh.Password(pw))
	}

	keyPath := keyPathOverride
	if keyPath == "" {
		keyPath = sess.KeyPath
	}
	if keyPath == "" && pw == "" && sess.AuthType != storage.AuthAgent {
		keyPath = DefaultPrivateKeyPath
	}
	passphrase := passphraseOverride
	if passphrase == "" {
		passphrase = sess.Passphrase
	}
	if keyPath != "" {
		signer, err := LoadPrivateKey(keyPath, passphrase)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("load private key: %w", err)
		}
		methods = append(methods, gossh.PublicKeys(signer))
	}

	var agentObj sshagent.Agent
	var agentCloser io.Closer
	if sess.AuthType == storage.AuthAgent {
		var err error
		agentObj, agentCloser, err = DialAgent()
		if err != nil {
			return nil, nil, nil, fmt.Errorf("ssh agent auth: %w", err)
		}
		methods = append(methods, gossh.PublicKeysCallback(agentObj.Signers))
	}

	if len(methods) == 0 {
		// Fallback: keyboard-interactive (prompts will not appear in GUI, but avoids hard fail)
		methods = append(methods, gossh.KeyboardInteractive(func(_, _ string, qs []string, _ []bool) ([]string, error) {
			return make([]string, len(qs)), nil
		}))
	}
	return methods, agentObj, agentCloser, nil
}

func (m *Manager) Connect(opts ConnectOptions) (string, error) {
	sess := opts.Session
	host := fmt.Sprintf("%s:%d", sess.Host, sess.Port)

	authMethods, sshAgentObj, agentCloser, err := buildAuthMethods(&sess, opts.Password, opts.KeyPath, opts.Passphrase)
	if err != nil {
		return "", err
	}
	// Closed automatically on any failure below; ownership passes to Conn
	// (closed on Disconnect) once the connection is fully established.
	agentConnected := false
	if agentCloser != nil {
		defer func() {
			if !agentConnected {
				agentCloser.Close()
			}
		}()
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
			if hostname == opts.SkipHostKeyHost {
				return nil
			}
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
	var jumpAgentCloser io.Closer

	if opts.JumpSession != nil {
		j := opts.JumpSession
		jumpAuth, _, jumpCloser, err := buildAuthMethods(j, "", "", "")
		if err != nil {
			return "", fmt.Errorf("jump host auth: %w", err)
		}
		jumpAgentCloser = jumpCloser
		if jumpAgentCloser != nil {
			defer func() {
				if !agentConnected {
					jumpAgentCloser.Close()
				}
			}()
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
	var stopKA chan struct{}
	if sess.Keepalive > 0 {
		stopKA = make(chan struct{})
		go func() {
			ticker := time.NewTicker(time.Duration(sess.Keepalive) * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					_, _, err := client.SendRequest("keepalive@openssh.com", true, nil)
					if err != nil {
						return
					}
				case <-stopKA:
					return
				}
			}
		}()
	}

	// ── Agent forwarding ──────────────────────────────────────────────────────
	// Cross-platform: ForwardToAgent just serves the Agent protocol over any
	// channel the remote side opens, so this works with both a real
	// SSH_AUTH_SOCK-backed agent and Windows' Pageant.
	forwardAgent := sess.ForwardAgent && sshAgentObj != nil
	if forwardAgent {
		if err := sshagent.ForwardToAgent(client, sshAgentObj); err != nil {
			log.Printf("ishell: agent forwarding setup failed: %v", err)
			forwardAgent = false
		}
	}

	// ── Open PTY session ──────────────────────────────────────────────────────
	connID := uuid.NewString()
	term, err := newTermSession(m.ctx, connID, client, opts.Cols, opts.Rows, forwardAgent)
	if err != nil {
		if stopKA != nil {
			close(stopKA)
		}
		client.Close()
		if jumpClient != nil {
			jumpClient.Close()
		}
		return "", fmt.Errorf("open pty: %w", err)
	}
	agentConnected = true

	conn := &Conn{
		ID:              connID,
		SessionID:       sess.ID,
		client:          client,
		jumpClient:      jumpClient,
		term:            term,
		sshAgent:        sshAgentObj,
		agentCloser:     agentCloser,
		jumpAgentCloser: jumpAgentCloser,
		stopKeepalive:   stopKA,
	}
	m.mu.Lock()
	m.conns[connID] = conn
	m.mu.Unlock()

	// Send initial command if configured
	if sess.InitCommand != "" {
		if err := term.Write([]byte(sess.InitCommand + "\n")); err != nil {
			log.Printf("ishell: init command write error for conn %s: %v", connID, err)
		}
	}

	// Auto-start any persisted port-forward rules for this session. Failures
	// are logged, not fatal — the terminal connection itself already succeeded.
	if m.store != nil {
		if rules, err := m.store.ListPortForwardsForSession(sess.ID); err == nil {
			for _, rule := range rules {
				if rule.AutoStart && rule.Enabled {
					if _, err := m.StartForward(connID, rule); err != nil {
						log.Printf("ishell: autostart forward %s for conn %s: %v", rule.ID, connID, err)
					}
				}
			}
		}
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
	m.stopAllForwards(conn)
	conn.mu.Lock()
	defer conn.mu.Unlock()
	if conn.stopKeepalive != nil {
		close(conn.stopKeepalive)
		conn.stopKeepalive = nil
	}
	if conn.term != nil {
		conn.term.Close()
	}
	if conn.sftpCl != nil {
		conn.sftpCl.Close()
	}
	if conn.agentCloser != nil {
		conn.agentCloser.Close()
	}
	if conn.jumpAgentCloser != nil {
		conn.jumpAgentCloser.Close()
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
	// Concurrent writes let File.ReadFrom pipeline write requests instead of
	// waiting one round-trip per 32KB packet, which is the difference between
	// ~640KB/s and full bandwidth on a 50ms-RTT link. Reads are pipelined by
	// default. The trade-off (a failed upload may leave the remote file
	// inconsistent) already applies to any partially-completed transfer.
	cl, err := sftp.NewClient(conn.client, sftp.UseConcurrentWrites(true))
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
