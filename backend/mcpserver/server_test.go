package mcpserver

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
)

type fakeSource struct {
	terminals   []TerminalInfo
	sendErr     error
	snapshotErr error
	sinceErr    error
	sentInput   []string
	sentConnID  string
	snapshot    []byte
	offset      int64
	since       []byte
}

func (f *fakeSource) ListTerminals() []TerminalInfo { return f.terminals }

func (f *fakeSource) SendInput(connID, data string) error {
	f.sentConnID = connID
	f.sentInput = append(f.sentInput, data)
	return f.sendErr
}

func (f *fakeSource) Snapshot(connID string) ([]byte, int64, error) {
	return f.snapshot, f.offset, f.snapshotErr
}

func (f *fakeSource) Since(connID string, offset int64) ([]byte, error) {
	return f.since, f.sinceErr
}

func req(args map[string]any) mcp.CallToolRequest {
	return mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: args}}
}

func text(t *testing.T, res *mcp.CallToolResult) string {
	t.Helper()
	if len(res.Content) == 0 {
		t.Fatalf("result has no content")
	}
	tc, ok := res.Content[0].(mcp.TextContent)
	if !ok {
		t.Fatalf("content[0] is not TextContent: %T", res.Content[0])
	}
	return tc.Text
}

func TestHandleListTerminals(t *testing.T) {
	src := &fakeSource{terminals: []TerminalInfo{
		{ConnID: "ssh-1", Label: "prod", Host: "1.2.3.4", Kind: "ssh"},
		{ConnID: "local-1", Label: "Local Shell", Kind: "local"},
	}}
	res, err := handleListTerminals(context.Background(), src, req(nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected tool error: %s", text(t, res))
	}
	got := text(t, res)
	if !contains(got, "ssh-1") || !contains(got, "local-1") {
		t.Fatalf("expected both conn_ids in JSON output, got: %s", got)
	}
}

func TestHandleTerminalRead(t *testing.T) {
	src := &fakeSource{snapshot: []byte("hello screen"), offset: 42}
	res, err := handleTerminalRead(context.Background(), src, req(map[string]any{"conn_id": "ssh-1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected tool error: %s", text(t, res))
	}
	if got := text(t, res); got != "hello screen" {
		t.Fatalf("expected snapshot text, got: %q", got)
	}
}

func TestHandleTerminalReadMissingConnID(t *testing.T) {
	src := &fakeSource{}
	res, err := handleTerminalRead(context.Background(), src, req(nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatalf("expected tool error for missing conn_id")
	}
}

func TestHandleTerminalReadSnapshotError(t *testing.T) {
	src := &fakeSource{snapshotErr: errors.New("session not found")}
	res, err := handleTerminalRead(context.Background(), src, req(map[string]any{"conn_id": "gone"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatalf("expected tool error when Snapshot fails")
	}
}

func TestHandleTerminalRun(t *testing.T) {
	src := &fakeSource{offset: 10, since: []byte("total 0\n")}
	res, err := handleTerminalRun(context.Background(), src, req(map[string]any{
		"conn_id": "ssh-1", "command": "ls -la", "wait_ms": float64(5),
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected tool error: %s", text(t, res))
	}
	if got := text(t, res); got != "total 0\n" {
		t.Fatalf("expected captured output, got: %q", got)
	}
	if src.sentConnID != "ssh-1" || len(src.sentInput) != 1 || src.sentInput[0] != "ls -la\n" {
		t.Fatalf("expected command sent with trailing newline to correct connID, got connID=%q input=%v", src.sentConnID, src.sentInput)
	}
}

func TestHandleTerminalRunMissingArgs(t *testing.T) {
	src := &fakeSource{}
	if res, _ := handleTerminalRun(context.Background(), src, req(map[string]any{"conn_id": "ssh-1"})); !res.IsError {
		t.Fatalf("expected tool error for missing command")
	}
	if res, _ := handleTerminalRun(context.Background(), src, req(map[string]any{"command": "ls"})); !res.IsError {
		t.Fatalf("expected tool error for missing conn_id")
	}
}

func TestHandleTerminalRunSendInputError(t *testing.T) {
	src := &fakeSource{sendErr: errors.New("session closed")}
	res, err := handleTerminalRun(context.Background(), src, req(map[string]any{"conn_id": "ssh-1", "command": "ls"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatalf("expected tool error when SendInput fails")
	}
}

func TestHandleTerminalRunCancelled(t *testing.T) {
	src := &fakeSource{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	res, err := handleTerminalRun(ctx, src, req(map[string]any{
		"conn_id": "ssh-1", "command": "sleep 10", "wait_ms": float64(60000),
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatalf("expected tool error when context is cancelled before wait elapses")
	}
}

func TestServerStartStopStatus(t *testing.T) {
	src := &fakeSource{}
	s := New(src)
	if running, _, _ := s.Status(); running {
		t.Fatalf("expected not running before Start")
	}
	if err := s.Start(0); err == nil {
		t.Fatalf("expected error for invalid port 0")
	}

	// Port 0 tells net.Listen to pick a free port; Start's own addr string
	// construction would produce "127.0.0.1:0", which is a valid bind
	// address but not what callers should rely on, so exercise a fixed
	// high port instead to keep the assertion meaningful.
	const port = 17378
	if err := s.Start(port); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer s.Stop(context.Background())

	running, addr, errMsg := s.Status()
	if !running {
		t.Fatalf("expected running after Start")
	}
	if addr == "" {
		t.Fatalf("expected non-empty addr")
	}
	if errMsg != nil {
		t.Fatalf("unexpected error: %v", errMsg)
	}

	// Idempotent restart on the same port should be a no-op, not an error.
	if err := s.Start(port); err != nil {
		t.Fatalf("re-Start on same port failed: %v", err)
	}

	time.Sleep(20 * time.Millisecond) // let the accept goroutine settle
	if err := s.Stop(context.Background()); err != nil {
		t.Fatalf("Stop failed: %v", err)
	}
	if running, _, _ := s.Status(); running {
		t.Fatalf("expected not running after Stop")
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}
