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

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{
		Cols: uint16(cols),
		Rows: uint16(rows),
	})
	if err != nil {
		return nil, fmt.Errorf("start pty: %w", err)
	}

	em := termout.New(ctx, connID)
	go func() {
		buf := make([]byte, 8192)
		for {
			n, readErr := ptmx.Read(buf)
			if n > 0 {
				em.Write(buf[:n])
			}
			if readErr != nil {
				break
			}
		}
		em.Close() // flush any buffered tail before signalling close
		wailsRuntime.EventsEmit(ctx, "terminal:closed:"+connID, nil)
	}()

	return newSession(
		ctx,
		em,
		func(data []byte) error {
			return writeAll(ptmx, data)
		},
		func(c, r int) error {
			return pty.Setsize(ptmx, &pty.Winsize{Cols: uint16(c), Rows: uint16(r)})
		},
		func() error {
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			return ptmx.Close()
		},
	), nil
}
