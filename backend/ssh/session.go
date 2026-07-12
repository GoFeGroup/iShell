package ssh

import (
	"context"
	"fmt"
	"io"
	"log"
	"sync"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	gossh "golang.org/x/crypto/ssh"
	sshagent "golang.org/x/crypto/ssh/agent"

	"ishell/backend/termout"
)

// TermSession wraps an interactive SSH shell session with a PTY.
type TermSession struct {
	connID    string
	session   *gossh.Session
	stdin     io.WriteCloser
	inputCh   chan []byte
	out       *termout.Emitter
	ctx       context.Context
	cancel    context.CancelFunc
	closeOnce sync.Once
}

func zmodemInputKind(data []byte) string {
	if len(data) == 19 {
		cancel := true
		for i := 0; i < 8; i++ {
			cancel = cancel && data[i] == 0x18
		}
		for i := 8; i < 18; i++ {
			cancel = cancel && data[i] == 0x08
		}
		if cancel && data[18] == 0x03 {
			return "cancel"
		}
	}
	if len(data) == 1 && data[0] == 0x03 {
		return "ctrl-c"
	}
	if len(data) >= 4 && data[0] == 0x2a && data[1] == 0x2a && data[2] == 0x18 && data[3] == 0x42 {
		return "frame"
	}
	return ""
}

// newTermSession opens a PTY shell on the given SSH client and starts
// streaming stdout/stderr back to the frontend via Wails events.
func newTermSession(ctx context.Context, connID string, client *gossh.Client, cols, rows int, forwardAgent bool) (*TermSession, error) {
	sess, err := client.NewSession()
	if err != nil {
		return nil, fmt.Errorf("open session: %w", err)
	}

	if forwardAgent {
		if err := sshagent.RequestAgentForwarding(sess); err != nil {
			log.Printf("ishell: agent forwarding request denied: %v", err)
		}
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

	sessionCtx, cancel := context.WithCancel(ctx)
	ts := &TermSession{
		connID:  connID,
		session: sess,
		stdin:   stdin,
		inputCh: make(chan []byte, 256),
		out:     termout.New(ctx, connID),
		ctx:     sessionCtx,
		cancel:  cancel,
	}

	// Single writer goroutine: guarantees FIFO order regardless of how many
	// concurrent goroutines call Write (Wails spawns one goroutine per IPC call).
	go ts.pumpInput()

	go ts.pumpOutput(stdout)
	go ts.pumpOutput(stderr)
	go func() {
		_ = sess.Wait()
		ts.out.Close() // flush any buffered tail before signalling close
		runtime.EventsEmit(ctx, "terminal:closed:"+connID, nil)
	}()

	return ts, nil
}

// pumpInput drains inputCh and writes to SSH stdin sequentially.
func (ts *TermSession) pumpInput() {
	for {
		select {
		case data := <-ts.inputCh:
			if _, err := ts.stdin.Write(data); err != nil {
				return
			}
		case <-ts.ctx.Done():
			return
		}
	}
}

func (ts *TermSession) pumpOutput(r io.Reader) {
	buf := make([]byte, 8192)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			// Both stdout and stderr readers share ts.out; its mutex serialises
			// them into a single ordered, coalesced event stream.
			ts.out.Write(buf[:n])
		}
		if err != nil {
			return
		}
	}
}

// Write enqueues data for the single writer goroutine.
// Returns immediately; actual SSH write happens in pumpInput.
func (ts *TermSession) Write(data []byte) error {
	buf := make([]byte, len(data))
	copy(buf, data)
	kind := zmodemInputKind(buf)
	if kind == "cancel" {
		ts.out.BeginZmodemDrain()
	}
	select {
	case ts.inputCh <- buf:
		return nil
	case <-ts.ctx.Done():
		return ts.ctx.Err()
	}
}

func (ts *TermSession) Resize(cols, rows int) error {
	return ts.session.WindowChange(rows, cols)
}

// Snapshot returns the recent raw output retained in the ring buffer and the
// offset to pass to a later Since() call. Used by AI tool calls to read what
// a terminal_run command produced.
func (ts *TermSession) Snapshot() ([]byte, int64) {
	return ts.out.Snapshot()
}

// Since returns output written after offset (best-effort, see Emitter.Since).
func (ts *TermSession) Since(offset int64) []byte {
	return ts.out.Since(offset)
}

func (ts *TermSession) Close() {
	ts.closeOnce.Do(func() {
		ts.cancel()
		_ = ts.stdin.Close()
		_ = ts.session.Close()
	})
}
