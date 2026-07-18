package ssh

import (
	"context"
	"io"
	"net"
	"testing"
	"time"

	"ishell/backend/storage"
)

func TestListForwardsReportsActiveAndErroredHandles(t *testing.T) {
	active := &forwardHandle{rule: storage.PortForward{ID: "active-rule", Type: storage.ForwardLocal}}
	errored := &forwardHandle{rule: storage.PortForward{ID: "errored-rule", Type: storage.ForwardLocal}, err: "listen closed"}
	conn := &Conn{forwards: map[string]*forwardHandle{
		active.rule.ID:  active,
		errored.rule.ID: errored,
	}}
	m := &Manager{ctx: context.Background(), conns: map[string]*Conn{"conn": conn}}

	statuses := m.ListForwards("conn")
	if len(statuses) != 2 {
		t.Fatalf("expected 2 statuses, got %d", len(statuses))
	}
	byID := make(map[string]ForwardStatus, len(statuses))
	for _, s := range statuses {
		byID[s.ID] = s
	}
	if !byID["active-rule"].Active || byID["active-rule"].Err != "" {
		t.Fatalf("active-rule status = %+v, want Active=true Err=\"\"", byID["active-rule"])
	}
	if byID["errored-rule"].Active || byID["errored-rule"].Err != "listen closed" {
		t.Fatalf("errored-rule status = %+v, want Active=false Err=\"listen closed\"", byID["errored-rule"])
	}
}

func TestListForwardsUnknownConnReturnsNil(t *testing.T) {
	m := &Manager{ctx: context.Background(), conns: map[string]*Conn{}}
	if got := m.ListForwards("missing"); got != nil {
		t.Fatalf("ListForwards(missing) = %v, want nil", got)
	}
}

func TestStopAllForwardsClosesListenersAndCancelsContext(t *testing.T) {
	ln1, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ln2, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	ctx1, cancel1 := context.WithCancel(context.Background())
	ctx2, cancel2 := context.WithCancel(context.Background())
	h1 := &forwardHandle{rule: storage.PortForward{ID: "r1"}, listener: ln1, cancel: cancel1}
	h2 := &forwardHandle{rule: storage.PortForward{ID: "r2"}, listener: ln2, cancel: cancel2}
	conn := &Conn{forwards: map[string]*forwardHandle{"r1": h1, "r2": h2}}
	m := &Manager{ctx: context.Background()}

	m.stopAllForwards(conn)

	for _, ctx := range []context.Context{ctx1, ctx2} {
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
			t.Fatal("expected context to be cancelled")
		}
	}
	if _, err := net.Dial("tcp", ln1.Addr().String()); err == nil {
		t.Fatal("expected listener 1 to be closed")
	}
	if _, err := net.Dial("tcp", ln2.Addr().String()); err == nil {
		t.Fatal("expected listener 2 to be closed")
	}
}

func TestWriteSocksReplyEncodesStatusCode(t *testing.T) {
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()

	go func() {
		if err := writeSocksReply(server, 0x05); err != nil {
			t.Errorf("writeSocksReply: %v", err)
		}
	}()

	buf := make([]byte, 10)
	if _, err := io.ReadFull(client, buf); err != nil {
		t.Fatalf("read reply: %v", err)
	}
	want := []byte{0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0}
	for i := range want {
		if buf[i] != want[i] {
			t.Fatalf("reply = % x, want % x", buf, want)
		}
	}
}

func TestSocks5HandshakeRejectsUnsupportedVersion(t *testing.T) {
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()

	errCh := make(chan error, 1)
	go func() { errCh <- socks5Handshake(server, nil) }()

	// VER=4 (not 5), NMETHODS=0. The handshake reads exactly these two
	// header bytes and rejects on the version check before ever reading a
	// methods list, so the write must not send more than that: net.Pipe's
	// Write blocks until every byte it sent has been read by the peer, and
	// a stranded unread byte here would deadlock the test.
	if _, err := client.Write([]byte{0x04, 0x00}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("expected an error for an unsupported SOCKS version")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("socks5Handshake did not return")
	}
}

func TestSocks5HandshakeRejectsUnsupportedCommand(t *testing.T) {
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()

	errCh := make(chan error, 1)
	go func() { errCh <- socks5Handshake(server, nil) }()

	// Greeting: VER=5, NMETHODS=1, METHODS=[0 - no auth]
	if _, err := client.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		t.Fatal(err)
	}
	greetReply := make([]byte, 2)
	if _, err := io.ReadFull(client, greetReply); err != nil {
		t.Fatalf("read greeting reply: %v", err)
	}
	if greetReply[0] != 0x05 || greetReply[1] != 0x00 {
		t.Fatalf("greeting reply = % x, want [05 00]", greetReply)
	}

	// Request: VER=5, CMD=0x02 (BIND, unsupported — we only do CONNECT)
	if _, err := client.Write([]byte{0x05, 0x02, 0x00, 0x01}); err != nil {
		t.Fatal(err)
	}
	// The command check fails before the address/port fields are read, but
	// it does write a "command not supported" SOCKS reply before returning
	// the error — drain it, or that write blocks forever and the handshake
	// goroutine never finishes.
	reply := make([]byte, 10)
	if _, err := io.ReadFull(client, reply); err != nil {
		t.Fatalf("read error reply: %v", err)
	}
	if reply[1] != 0x07 {
		t.Fatalf("reply code = %#x, want 0x07 (command not supported)", reply[1])
	}
	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("expected an error for an unsupported SOCKS command")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("socks5Handshake did not return")
	}
}

func TestSocks5HandshakeRejectsUnsupportedAddressType(t *testing.T) {
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()

	errCh := make(chan error, 1)
	go func() { errCh <- socks5Handshake(server, nil) }()

	if _, err := client.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		t.Fatal(err)
	}
	greetReply := make([]byte, 2)
	if _, err := io.ReadFull(client, greetReply); err != nil {
		t.Fatalf("read greeting reply: %v", err)
	}

	// Request: VER=5, CMD=1 (CONNECT), RSV=0, ATYP=0x7f (invalid)
	if _, err := client.Write([]byte{0x05, 0x01, 0x00, 0x7f}); err != nil {
		t.Fatal(err)
	}
	// As above: the address-type check writes an error reply before
	// returning, which must be drained to unblock the handshake goroutine.
	reply := make([]byte, 10)
	if _, err := io.ReadFull(client, reply); err != nil {
		t.Fatalf("read error reply: %v", err)
	}
	if reply[1] != 0x08 {
		t.Fatalf("reply code = %#x, want 0x08 (address type not supported)", reply[1])
	}
	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("expected an error for an unsupported address type")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("socks5Handshake did not return")
	}
}
