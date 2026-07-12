package backend

// Verifies the real App wiring (not a fake TerminalSource): Settings ->
// mcpserver.Server lifecycle via SaveSettings/Startup/Shutdown, and a real
// Streamable HTTP + MCP client handshake against App.ListTerminals over the
// wire. Sandboxed to a temp data directory via APPDATA so it never touches
// the real user profile. Does not open any terminal session, since PTY
// output requires a live Wails runtime context to emit events (panics
// otherwise) — see backend/mcpserver's own integration test for the
// terminal-tool coverage against a real Streamable HTTP transport.

import (
	"context"
	"testing"
	"time"

	mcpclient "github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/mcp"
)

func TestAppMCPServerLifecycle(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())

	app := NewApp()
	app.Startup(context.Background())
	defer app.Shutdown(context.Background())

	if st := app.GetMCPServerStatus(); st.Running {
		t.Fatalf("expected MCP server not running before it's enabled in settings")
	}

	settings, err := app.GetSettings()
	if err != nil {
		t.Fatalf("GetSettings: %v", err)
	}
	settings.MCPServerEnabled = true
	settings.MCPServerPort = 17380
	if err := app.SaveSettings(*settings); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}

	st := app.GetMCPServerStatus()
	if !st.Running {
		t.Fatalf("expected MCP server running after enabling it, status: %+v", st)
	}
	if st.Addr != "http://127.0.0.1:17380/mcp" {
		t.Fatalf("unexpected addr: %q", st.Addr)
	}

	cli, err := mcpclient.NewStreamableHttpClient(st.Addr)
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
	initReq.Params.ClientInfo = mcp.Implementation{Name: "ishell-app-integration-test", Version: "1.0.0"}
	if _, err := cli.Initialize(ctx, initReq); err != nil {
		t.Fatalf("Initialize: %v", err)
	}

	res, err := cli.CallTool(ctx, mcp.CallToolRequest{Params: mcp.CallToolParams{Name: "list_terminals"}})
	if err != nil {
		t.Fatalf("CallTool list_terminals: %v", err)
	}
	if res.IsError {
		t.Fatalf("list_terminals returned an error result")
	}
	// No terminals are open in this sandboxed run; a clean empty-array
	// response (no panic, no 500) is exactly what proves App.ListTerminals
	// is wired correctly end to end.
	got := ""
	for _, c := range res.Content {
		if tc, ok := c.(mcp.TextContent); ok {
			got += tc.Text
		}
	}
	if got != "[]" {
		t.Fatalf("expected empty terminal list, got: %s", got)
	}

	// Disabling should stop the listener.
	settings.MCPServerEnabled = false
	if err := app.SaveSettings(*settings); err != nil {
		t.Fatalf("SaveSettings (disable): %v", err)
	}
	if st := app.GetMCPServerStatus(); st.Running {
		t.Fatalf("expected MCP server stopped after disabling it")
	}
}
