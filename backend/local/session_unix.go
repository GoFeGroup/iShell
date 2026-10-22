//go:build !windows

package local

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"ishell/backend/termout"
)

func defaultShell() string {
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}
	if runtime.GOOS == "darwin" {
		if shell := macOSUserShell(); shell != "" {
			return shell
		}
		if _, err := os.Stat("/bin/zsh"); err == nil {
			return "/bin/zsh"
		}
	}
	return "bash"
}

func terminalEnv() []string {
	env := os.Environ()
	if !hasUTF8Locale(env, "LANG") {
		env = upsertEnv(env, "LANG", "en_US.UTF-8")
	}
	if !hasUTF8Locale(env, "LC_CTYPE") {
		env = upsertEnv(env, "LC_CTYPE", "en_US.UTF-8")
	}
	return append(env, "TERM=xterm-256color")
}

func hasUTF8Locale(env []string, key string) bool {
	prefix := key + "="
	for _, item := range env {
		if len(item) <= len(prefix) || item[:len(prefix)] != prefix {
			continue
		}
		value := strings.ToUpper(item[len(prefix):])
		return strings.Contains(value, "UTF-8") || strings.Contains(value, "UTF8")
	}
	return false
}

func upsertEnv(env []string, key, value string) []string {
	prefix := key + "="
	for i, item := range env {
		if len(item) >= len(prefix) && item[:len(prefix)] == prefix {
			env[i] = prefix + value
			return env
		}
	}
	return append(env, prefix+value)
}

func macOSUserShell() string {
	u, err := user.Current()
	if err != nil || u.Username == "" {
		return ""
	}

	out, err := exec.Command("/usr/bin/dscl", ".", "-read", "/Users/"+u.Username, "UserShell").Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "UserShell:") {
			return strings.TrimSpace(strings.TrimPrefix(line, "UserShell:"))
		}
	}
	return ""
}

func shellCommand(shell string) *exec.Cmd {
	cmd := exec.Command(shell)
	if runtime.GOOS == "darwin" {
		base := filepath.Base(shell)
		if base != "" {
			cmd.Args = []string{"-" + base}
		}
	}
	return cmd
}

func writeAll(w io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := w.Write(data)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}

// drainTimeout bounds how long, after the shell has exited, we wait for the
// PTY reader to drain the remaining output. Descendants that inherited the
// slave side (e.g. background jobs) can keep the PTY open indefinitely, which
// would otherwise delay the close event forever.
const drainTimeout = 300 * time.Millisecond

// reapTimeout bounds how long an explicit Close waits for the killed shell to
// be reaped. The reap itself always completes in the background.
const reapTimeout = 3 * time.Second

// ptyProcess owns a shell started on a PTY and its full lifecycle: exactly one
// goroutine calls cmd.Wait so the child is always reaped (no <defunct>
// entries), and the output tail is flushed before onClosed fires exactly once.
type ptyProcess struct {
	cmd  *exec.Cmd
	ptmx *os.File
	em   *termout.Emitter

	processDone chan struct{} // closed once cmd.Wait has returned
	finished    chan struct{} // closed after output is flushed and onClosed ran

	ptmxOnce  sync.Once
	ptmxErr   error
	closeOnce sync.Once
	closeErr  error
}

func startPTY(cmd *exec.Cmd, cols, rows int, em *termout.Emitter, onClosed func()) (*ptyProcess, error) {
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{
		Cols: uint16(cols),
		Rows: uint16(rows),
	})
	if err != nil {
		return nil, fmt.Errorf("start pty: %w", err)
	}

	p := &ptyProcess{
		cmd:         cmd,
		ptmx:        ptmx,
		em:          em,
		processDone: make(chan struct{}),
		finished:    make(chan struct{}),
	}
	readDone := make(chan struct{})

	// The only cmd.Wait call. It runs independently of the PTY reader because
	// the reader may stay blocked after the shell exits.
	go func() {
		_ = cmd.Wait()
		close(p.processDone)
	}()

	go func() {
		defer close(readDone)
		buf := make([]byte, 8192)
		for {
			n, readErr := ptmx.Read(buf)
			if n > 0 {
				em.Write(buf[:n])
			}
			if readErr != nil {
				return
			}
		}
	}()

	go p.finish(readDone, onClosed)

	return p, nil
}

// finish waits for the shell to exit (or the PTY to close), lets the reader
// drain the tail, releases the PTY, then flushes output and signals close.
func (p *ptyProcess) finish(readDone <-chan struct{}, onClosed func()) {
	select {
	case <-readDone:
	case <-p.processDone:
		select {
		case <-readDone:
		case <-time.After(drainTimeout):
			_ = p.closePTY()
			select {
			case <-readDone:
			case <-time.After(drainTimeout):
			}
		}
	}
	_ = p.closePTY()
	p.em.Close() // flush any buffered tail before signalling close
	onClosed()
	close(p.finished)
}

func (p *ptyProcess) closePTY() error {
	p.ptmxOnce.Do(func() {
		p.ptmxErr = p.ptmx.Close()
	})
	return p.ptmxErr
}

func (p *ptyProcess) write(data []byte) error {
	return writeAll(p.ptmx, data)
}

func (p *ptyProcess) resize(cols, rows int) error {
	return pty.Setsize(p.ptmx, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}

// Close kills the shell, releases the PTY and waits (bounded) for the reaper
// goroutine to collect the exit status. Safe to call concurrently and
// repeatedly; it never calls cmd.Wait itself.
func (p *ptyProcess) Close() error {
	p.closeOnce.Do(func() {
		select {
		case <-p.processDone:
		default:
			_ = p.cmd.Process.Kill()
		}
		p.closeErr = p.closePTY()
		select {
		case <-p.processDone:
		case <-time.After(reapTimeout):
		}
	})
	return p.closeErr
}

func startSession(ctx context.Context, connID string, cols, rows int) (*session, error) {
	shell := defaultShell()
	cmd := shellCommand(shell)
	cmd.Env = terminalEnv()
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}

	if cols <= 0 {
		cols = 220
	}
	if rows <= 0 {
		rows = 50
	}

	em := termout.New(ctx, connID)
	proc, err := startPTY(cmd, cols, rows, em, func() {
		wailsRuntime.EventsEmit(ctx, "terminal:closed:"+connID, nil)
	})
	if err != nil {
		return nil, err
	}

	sess := newSession(ctx, em, proc.write, proc.resize, proc.Close)
	// Natural exit: stop the input pump without depending on the frontend
	// calling Disconnect after it receives terminal:closed.
	go func() {
		<-proc.finished
		sess.cancel()
	}()
	return sess, nil
}
