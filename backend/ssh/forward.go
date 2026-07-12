package ssh

import (
	"context"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
	gossh "golang.org/x/crypto/ssh"
	"ishell/backend/storage"
)

// ForwardStatus is the runtime state of one active port-forward tunnel,
// reported to the frontend.
type ForwardStatus struct {
	ID     string              `json:"id"`
	Rule   storage.PortForward `json:"rule"`
	Active bool                `json:"active"`
	Err    string              `json:"error,omitempty"`
}

type forwardHandle struct {
	rule     storage.PortForward
	listener net.Listener
	cancel   context.CancelFunc
	mu       sync.Mutex
	err      string
}

// StartForward opens a tunnel for rule against connID's SSH connection and
// returns the (possibly newly assigned) rule ID used to track it. The tunnel
// runs in background goroutines until StopForward is called, the listener
// errors, or the connection is disconnected.
func (m *Manager) StartForward(connID string, rule storage.PortForward) (string, error) {
	conn := m.get(connID)
	if conn == nil {
		return "", fmt.Errorf("connection %s not found", connID)
	}
	if rule.ID == "" {
		rule.ID = uuid.NewString()
	}
	if rule.BindAddr == "" {
		rule.BindAddr = "127.0.0.1"
	}
	addr := net.JoinHostPort(rule.BindAddr, strconv.Itoa(rule.BindPort))

	var listener net.Listener
	var err error
	if rule.Type == storage.ForwardRemote {
		// Remote forwards listen on the SSH server side via a tcpip-forward
		// global request; x/crypto/ssh exposes this as Client.Listen.
		listener, err = conn.client.Listen("tcp", addr)
	} else {
		listener, err = net.Listen("tcp", addr)
	}
	if err != nil {
		return "", fmt.Errorf("listen on %s: %w", addr, err)
	}

	ctx, cancel := context.WithCancel(m.ctx)
	handle := &forwardHandle{rule: rule, listener: listener, cancel: cancel}

	conn.forwardsMu.Lock()
	if conn.forwards == nil {
		conn.forwards = make(map[string]*forwardHandle)
	}
	if _, exists := conn.forwards[rule.ID]; exists {
		conn.forwardsMu.Unlock()
		cancel()
		listener.Close()
		return "", fmt.Errorf("forward %s is already running", rule.ID)
	}
	conn.forwards[rule.ID] = handle
	conn.forwardsMu.Unlock()

	go m.acceptForwardConns(ctx, conn, handle)

	return rule.ID, nil
}

// StopForward cancels and closes a running tunnel. It is a no-op error if the
// forward is not currently active (e.g. already stopped).
func (m *Manager) StopForward(connID, forwardID string) error {
	conn := m.get(connID)
	if conn == nil {
		return fmt.Errorf("connection %s not found", connID)
	}
	conn.forwardsMu.Lock()
	handle, ok := conn.forwards[forwardID]
	conn.forwardsMu.Unlock()
	if !ok {
		return fmt.Errorf("forward %s not found", forwardID)
	}
	handle.cancel()
	handle.listener.Close()
	return nil
}

// ListForwards returns the state of every tunnel currently running for connID.
func (m *Manager) ListForwards(connID string) []ForwardStatus {
	conn := m.get(connID)
	if conn == nil {
		return nil
	}
	conn.forwardsMu.Lock()
	defer conn.forwardsMu.Unlock()
	out := make([]ForwardStatus, 0, len(conn.forwards))
	for _, h := range conn.forwards {
		h.mu.Lock()
		errStr := h.err
		h.mu.Unlock()
		out = append(out, ForwardStatus{ID: h.rule.ID, Rule: h.rule, Active: errStr == "", Err: errStr})
	}
	return out
}

// stopAllForwards cancels every tunnel for conn. Called from Disconnect.
func (m *Manager) stopAllForwards(conn *Conn) {
	conn.forwardsMu.Lock()
	handles := make([]*forwardHandle, 0, len(conn.forwards))
	for _, h := range conn.forwards {
		handles = append(handles, h)
	}
	conn.forwardsMu.Unlock()
	for _, h := range handles {
		h.cancel()
		h.listener.Close()
	}
}

func (m *Manager) acceptForwardConns(ctx context.Context, conn *Conn, handle *forwardHandle) {
	defer func() {
		handle.listener.Close()
		conn.forwardsMu.Lock()
		if conn.forwards[handle.rule.ID] == handle {
			delete(conn.forwards, handle.rule.ID)
		}
		conn.forwardsMu.Unlock()
	}()
	for {
		local, err := handle.listener.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return // deliberate stop — not an error
			default:
			}
			handle.mu.Lock()
			handle.err = err.Error()
			handle.mu.Unlock()
			return
		}
		go m.handleForwardConn(conn, handle, local)
	}
}

func (m *Manager) handleForwardConn(conn *Conn, handle *forwardHandle, local net.Conn) {
	switch handle.rule.Type {
	case storage.ForwardLocal:
		target := net.JoinHostPort(handle.rule.TargetHost, strconv.Itoa(handle.rule.TargetPort))
		remote, err := conn.client.Dial("tcp", target)
		if err != nil {
			local.Close()
			return
		}
		pumpBidirectional(local, remote)
	case storage.ForwardRemote:
		target := net.JoinHostPort(handle.rule.TargetHost, strconv.Itoa(handle.rule.TargetPort))
		remote, err := net.Dial("tcp", target)
		if err != nil {
			local.Close()
			return
		}
		pumpBidirectional(local, remote)
	case storage.ForwardDynamic:
		handleSOCKS5(local, conn.client)
	default:
		local.Close()
	}
}

// pumpBidirectional copies data between a and b until either side closes or
// errors, then closes both ends and waits for both copy goroutines to exit.
func pumpBidirectional(a, b net.Conn) {
	var once sync.Once
	stop := func() { once.Do(func() { a.Close(); b.Close() }) }
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); io.Copy(a, b); stop() }()
	go func() { defer wg.Done(); io.Copy(b, a); stop() }()
	wg.Wait()
}

// ── Minimal SOCKS5 server (RFC 1928 §3-4, CONNECT only, no auth) ────────────

func handleSOCKS5(conn net.Conn, client *gossh.Client) {
	if err := socks5Handshake(conn, client); err != nil {
		conn.Close()
	}
}

func socks5Handshake(conn net.Conn, client *gossh.Client) error {
	conn.SetDeadline(time.Now().Add(10 * time.Second))

	// Greeting: VER(1) NMETHODS(1) METHODS(NMETHODS)
	hdr := make([]byte, 2)
	if _, err := io.ReadFull(conn, hdr); err != nil {
		return err
	}
	if hdr[0] != 0x05 {
		return fmt.Errorf("unsupported socks version %d", hdr[0])
	}
	methods := make([]byte, hdr[1])
	if _, err := io.ReadFull(conn, methods); err != nil {
		return err
	}
	// No authentication required.
	if _, err := conn.Write([]byte{0x05, 0x00}); err != nil {
		return err
	}

	// Request: VER(1) CMD(1) RSV(1) ATYP(1) DST.ADDR DST.PORT(2)
	req := make([]byte, 4)
	if _, err := io.ReadFull(conn, req); err != nil {
		return err
	}
	if req[0] != 0x05 {
		return fmt.Errorf("unsupported socks version %d", req[0])
	}
	if req[1] != 0x01 { // CONNECT only
		writeSocksReply(conn, 0x07) // command not supported
		return fmt.Errorf("unsupported socks command %d", req[1])
	}

	var host string
	switch req[3] {
	case 0x01: // IPv4
		addr := make([]byte, net.IPv4len)
		if _, err := io.ReadFull(conn, addr); err != nil {
			return err
		}
		host = net.IP(addr).String()
	case 0x03: // domain name
		lenBuf := make([]byte, 1)
		if _, err := io.ReadFull(conn, lenBuf); err != nil {
			return err
		}
		domain := make([]byte, lenBuf[0])
		if _, err := io.ReadFull(conn, domain); err != nil {
			return err
		}
		host = string(domain)
	case 0x04: // IPv6
		addr := make([]byte, net.IPv6len)
		if _, err := io.ReadFull(conn, addr); err != nil {
			return err
		}
		host = net.IP(addr).String()
	default:
		writeSocksReply(conn, 0x08) // address type not supported
		return fmt.Errorf("unsupported socks address type %d", req[3])
	}
	portBuf := make([]byte, 2)
	if _, err := io.ReadFull(conn, portBuf); err != nil {
		return err
	}
	port := int(portBuf[0])<<8 | int(portBuf[1])
	target := net.JoinHostPort(host, strconv.Itoa(port))

	remote, err := client.Dial("tcp", target)
	if err != nil {
		writeSocksReply(conn, 0x05) // connection refused
		return err
	}
	if err := writeSocksReply(conn, 0x00); err != nil {
		remote.Close()
		return err
	}
	conn.SetDeadline(time.Time{})
	pumpBidirectional(conn, remote)
	return nil
}

func writeSocksReply(conn net.Conn, code byte) error {
	// BND.ADDR/BND.PORT are not meaningful for our use, so 0.0.0.0:0 is sent.
	_, err := conn.Write([]byte{0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
	return err
}
