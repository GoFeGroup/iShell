// Package mcpserver exposes iShell's terminals to external MCP clients (the
// official `claude`/`codex` CLIs, or any other MCP-speaking tool) over local
// Streamable HTTP. It is opt-in via Settings.MCPServerEnabled: once enabled,
// any process that can reach 127.0.0.1:<port> is fully trusted to read and
// execute commands in whichever terminal it names — there is no per-call
// approval, unlike the built-in AI sidebar's tool-calling loop.
package mcpserver

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// commandWaitDelay mirrors backend/ai/agent.go's commandWaitDelay: time to
// let a sent command produce output before reading it back, absent any
// shell-prompt detection.
const commandWaitDelay = 800 * time.Millisecond

// TerminalInfo describes one open terminal tab for the list_terminals tool.
type TerminalInfo struct {
	ConnID string `json:"conn_id"`
	Label  string `json:"label"`
	Host   string `json:"host,omitempty"`
	Kind   string `json:"kind"` // "ssh" | "local"
}

// TerminalSource is the subset of App's terminal-management surface this
// server needs. Implemented by *backend.App.
type TerminalSource interface {
	ListTerminals() []TerminalInfo
	SendInput(connID, data string) error
	Snapshot(connID string) (data []byte, offset int64, err error)
	Since(connID string, offset int64) ([]byte, error)
}

// Server wraps an MCP tool server and its Streamable HTTP transport. Zero
// value is not usable; construct with New.
type Server struct {
	src TerminalSource

	mu      sync.Mutex
	running bool
	addr    string
	lastErr error
	httpSrv *server.StreamableHTTPServer
	ln      net.Listener
}

func New(src TerminalSource) *Server {
	return &Server{src: src}
}

// Start binds 127.0.0.1:port and begins serving MCP over Streamable HTTP.
// Idempotent: calling Start while already running on the same port is a
// no-op; calling it on a different port stops the old listener first.
func (s *Server) Start(port int) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	addr := "127.0.0.1:" + strconv.Itoa(port)
	if s.running && s.addr == addr {
		return nil
	}
	if s.running {
		s.stopLocked()
	}
	if port <= 0 {
		return fmt.Errorf("invalid MCP server port: %d", port)
	}

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		s.lastErr = err
		return err
	}

	mcpSrv := server.NewMCPServer("ishell", "1.0.0")
	registerTools(mcpSrv, s.src)
	httpSrv := server.NewStreamableHTTPServer(mcpSrv, server.WithEndpointPath("/mcp"))

	s.httpSrv = httpSrv
	s.ln = ln
	s.addr = addr
	s.running = true
	s.lastErr = nil

	go func() {
		srv := &http.Server{Handler: httpSrv}
		err := srv.Serve(ln)
		if err != nil && err != http.ErrServerClosed {
			s.mu.Lock()
			s.lastErr = err
			s.running = false
			s.mu.Unlock()
		}
	}()

	return nil
}

// Stop shuts the server down, if running.
func (s *Server) Stop(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stopLocked()
}

func (s *Server) stopLocked() error {
	if !s.running {
		return nil
	}
	s.running = false
	var err error
	if s.httpSrv != nil {
		err = s.httpSrv.Shutdown(context.Background())
	}
	if s.ln != nil {
		_ = s.ln.Close()
	}
	s.httpSrv = nil
	s.ln = nil
	return err
}

// Status reports whether the server is running, its listen address
// (http://127.0.0.1:port/mcp), and the last error encountered, if any.
func (s *Server) Status() (running bool, addr string, lastErr error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.running {
		return false, "", s.lastErr
	}
	return true, "http://" + s.addr + "/mcp", nil
}

func registerTools(mcpSrv *server.MCPServer, src TerminalSource) {
	mcpSrv.AddTool(mcp.NewTool("list_terminals",
		mcp.WithDescription("List every terminal tab currently open in iShell (SSH connections and local shells), with the conn_id needed by terminal_read/terminal_run."),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return handleListTerminals(ctx, src, req)
	})

	mcpSrv.AddTool(mcp.NewTool("terminal_read",
		mcp.WithDescription("Read the current on-screen output and recent scrollback of one iShell terminal tab, identified by conn_id (see list_terminals). Read-only, does not send any input."),
		mcp.WithString("conn_id", mcp.Required(), mcp.Description("The conn_id of the terminal tab to read, from list_terminals.")),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return handleTerminalRead(ctx, src, req)
	})

	mcpSrv.AddTool(mcp.NewTool("terminal_run",
		mcp.WithDescription("Run a shell command in one iShell terminal tab, identified by conn_id (see list_terminals), and return the output produced. This actually executes on the target terminal (local shell or live SSH session); double-check conn_id points at the intended tab before calling."),
		mcp.WithString("conn_id", mcp.Required(), mcp.Description("The conn_id of the terminal tab to run the command in, from list_terminals.")),
		mcp.WithString("command", mcp.Required(), mcp.Description("The shell command to run, without a trailing newline.")),
		mcp.WithNumber("wait_ms", mcp.Description("Milliseconds to wait for output before capturing it. Defaults to 800; increase for slow commands.")),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return handleTerminalRun(ctx, src, req)
	})
}

func handleListTerminals(_ context.Context, src TerminalSource, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return mcp.NewToolResultJSON(src.ListTerminals())
}

func handleTerminalRead(_ context.Context, src TerminalSource, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	connID, err := req.RequireString("conn_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	data, _, err := src.Snapshot(connID)
	if err != nil {
		return mcp.NewToolResultErrorFromErr("snapshot failed", err), nil
	}
	return mcp.NewToolResultText(string(data)), nil
}

func handleTerminalRun(ctx context.Context, src TerminalSource, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	connID, err := req.RequireString("conn_id")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	command, err := req.RequireString("command")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	wait := commandWaitDelay
	if ms := req.GetFloat("wait_ms", 0); ms > 0 {
		wait = time.Duration(ms) * time.Millisecond
	}

	_, offsetBefore, err := src.Snapshot(connID)
	if err != nil {
		return mcp.NewToolResultErrorFromErr("snapshot failed", err), nil
	}
	if err := src.SendInput(connID, command+"\n"); err != nil {
		return mcp.NewToolResultErrorFromErr("send input failed", err), nil
	}

	select {
	case <-time.After(wait):
	case <-ctx.Done():
		return mcp.NewToolResultError("cancelled before output could be captured"), nil
	}

	output, err := src.Since(connID, offsetBefore)
	if err != nil {
		return mcp.NewToolResultErrorFromErr("reading output failed", err), nil
	}
	return mcp.NewToolResultText(string(output)), nil
}
