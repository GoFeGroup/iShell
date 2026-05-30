package ssh

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	gossh "golang.org/x/crypto/ssh"
)

// TermSession wraps an interactive SSH shell session with a PTY.
type TermSession struct {
	connID  string
	session *gossh.Session
	stdin   io.WriteCloser
	ctx     context.Context
}

// newTermSession opens a PTY shell on the given SSH client and starts
// streaming stdout/stderr back to the frontend via Wails events.
func newTermSession(ctx context.Context, connID string, client *gossh.Client, cols, rows int) (*TermSession, error) {
	sess, err := client.NewSession()
	if err != nil {
		return nil, fmt.Errorf("open session: %w", err)
	}

	modes := gossh.TerminalModes{
		gossh.ECHO:          1,
		gossh.TTY_OP_ISPEED: 14400,
		gossh.TTY_OP_OSPEED: 14400,
	}
	if cols <= 0 {
		cols = 220
	}
	if rows <= 0 {
		rows = 50
	}
	if err := sess.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		sess.Close()
		return nil, fmt.Errorf("request pty: %w", err)
	}

	stdin, err := sess.StdinPipe()
	if err != nil {
		sess.Close()
		return nil, fmt.Errorf("stdin pipe: %w", err)
	}

	stdout, err := sess.StdoutPipe()
	if err != nil {
		sess.Close()
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}
	stderr, err := sess.StderrPipe()
	if err != nil {
		sess.Close()
		return nil, fmt.Errorf("stderr pipe: %w", err)
	}

	if err := sess.Shell(); err != nil {
		sess.Close()
		return nil, fmt.Errorf("start shell: %w", err)
	}

	ts := &TermSession{connID: connID, session: sess, stdin: stdin, ctx: ctx}

	// Stream stdout
	go ts.pumpOutput(stdout)
	// Stream stderr to the same terminal channel
	go ts.pumpOutput(stderr)
	// Notify frontend when the session ends
	go func() {
		_ = sess.Wait()
		runtime.EventsEmit(ctx, "terminal:closed:"+connID, nil)
	}()

	return ts, nil
}

func (ts *TermSession) pumpOutput(r io.Reader) {
	buf := make([]byte, 8192)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			encoded := base64.StdEncoding.EncodeToString(buf[:n])
			runtime.EventsEmit(ts.ctx, "terminal:data:"+ts.connID, encoded)
		}
		if err != nil {
			return
		}
	}
}

func (ts *TermSession) Write(data []byte) error {
	_, err := ts.stdin.Write(data)
	return err
}

func (ts *TermSession) Resize(cols, rows int) error {
	return ts.session.WindowChange(rows, cols)
}

func (ts *TermSession) Close() {
	_ = ts.stdin.Close()
	_ = ts.session.Close()
}
