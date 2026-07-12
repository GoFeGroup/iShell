package mcpserver_test

// This test exercises the whole network/protocol path a real claude/codex
// CLI would take: a real TCP listener, real Streamable HTTP transport, a
// real MCP client handshake (protocol negotiation, tools/call JSON-RPC over
// the wire) against a real *mcpserver.Server — the same client library
// semantics the official CLIs use. Only the terminal itself is faked here:
// wiring this to a genuine PTY session (backend/local.Manager) requires a
// live Wails runtime context for its output-event sink
// (wailsRuntime.EventsEmit panics outside an actual running app), which
// isn't available in a headless `go test` run. That PTY plumbing is already
// covered by backend/local's own test suite; App's compile-time
// satisfaction of mcpserver.TerminalSource covers the last mile.

import (
	"context"
	"strings"
	"testing"
	"time"

	mcpclient "github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/mcp"

	"ishell/backend/mcpserver"
)

type fakeSource struct {
	terminals []mcpserver.TerminalInfo
	buf       []byte
	sentTo    string
	sentData  string
}

func (f *fakeSource) ListTerminals() []mcpserver.TerminalInfo { return f.terminals }

func (f *fakeSource) SendInput(connID, data string) error {
	f.sentTo, f.sentData = connID, data
	f.buf = append(f.buf, []byte(data)...)
	return nil
}

func (f *fakeSource) Snapshot(connID string) ([]byte, int64, error) {
	return f.buf, int64(len(f.buf)), nil
}

func (f *fakeSource) Since(connID string, offset int64) ([]byte, error) {
	if offset >= int64(len(f.buf)) {
		return nil, nil
	}
	return f.buf[offset:], nil
}

func TestEndToEndOverRealHTTP(t *testing.T) {
	src := &fakeSource{terminals: []mcpserver.TerminalInfo{
		{ConnID: "local-e2e-1", Label: "Local Shell", Kind: "local"},
	}}
	srv := mcpserver.New(src)
	const port = 17379
	if err := srv.Start(port); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer srv.Stop(context.Background())

	cli, err := mcpclient.NewStreamableHttpClient("http://127.0.0.1:17379/mcp")
	if err != nil {
		t.Fatalf("new MCP client: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := cli.Start(ctx); err != nil {
		t.Fatalf("client Start: %v", err)
	}
	defer cli.Close()

	initReq := mcp.InitializeRequest{}
	initReq.Params.ProtocolVersion = mcp.LATEST_PROTOCOL_VERSION
	initReq.Params.ClientInfo = mcp.Implementation{Name: "ishell-integration-test", Version: "1.0.0"}
	if _, err := cli.Initialize(ctx, initReq); err != nil {
		t.Fatalf("Initialize: %v", err)
	}

	tools, err := cli.ListTools(ctx, mcp.ListToolsRequest{})
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	names := map[string]bool{}
	for _, tool := range tools.Tools {
		names[tool.Name] = true
	}
	for _, want := range []string{"list_terminals", "terminal_read", "terminal_run"} {
		if !names[want] {
			t.Fatalf("expected tool %q to be advertised, got: %v", want, names)
		}
	}

	listRes, err := cli.CallTool(ctx, mcp.CallToolRequest{Params: mcp.CallToolParams{Name: "list_terminals"}})
	if err != nil {
		t.Fatalf("CallTool list_terminals: %v", err)
	}
	if listRes.IsError {
		t.Fatalf("list_terminals returned an error result")
	}
	if got := resultText(t, listRes); !strings.Contains(got, "local-e2e-1") {
		t.Fatalf("expected list_terminals output to contain conn_id, got: %s", got)
	}

	runRes, err := cli.CallTool(ctx, mcp.CallToolRequest{Params: mcp.CallToolParams{
		Name:      "terminal_run",
		Arguments: map[string]any{"conn_id": "local-e2e-1", "command": "echo hi", "wait_ms": float64(10)},
	}})
	if err != nil {
		t.Fatalf("CallTool terminal_run: %v", err)
	}
	if runRes.IsError {
		t.Fatalf("terminal_run returned an error result: %s", resultText(t, runRes))
	}
	if src.sentTo != "local-e2e-1" || src.sentData != "echo hi\n" {
		t.Fatalf("expected command relayed to fake terminal with trailing newline, got connID=%q data=%q", src.sentTo, src.sentData)
	}
	if got := resultText(t, runRes); !strings.Contains(got, "echo hi") {
		t.Fatalf("expected terminal_run output to echo back sent input, got: %s", got)
	}

	readRes, err := cli.CallTool(ctx, mcp.CallToolRequest{Params: mcp.CallToolParams{
		Name:      "terminal_read",
		Arguments: map[string]any{"conn_id": "local-e2e-1"},
	}})
	if err != nil {
		t.Fatalf("CallTool terminal_read: %v", err)
	}
	if readRes.IsError {
		t.Fatalf("terminal_read returned an error result")
	}
	if got := resultText(t, readRes); !strings.Contains(got, "echo hi") {
		t.Fatalf("expected terminal_read to see the same buffered input, got: %s", got)
	}
}

func resultText(t *testing.T, res *mcp.CallToolResult) string {
	t.Helper()
	var sb strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(mcp.TextContent); ok {
			sb.WriteString(tc.Text)
		}
	}
	return sb.String()
}
