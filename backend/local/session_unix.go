//go:build !windows

package local

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"

	"github.com/creack/pty"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

func defaultShell() string {
	if runtime.GOOS == "darwin" {
		if _, err := exec.LookPath("zsh"); err == nil {
			return "zsh"
		}
	}
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
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
	cmd := exec.Command(shell)
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

	go func() {
		buf := make([]byte, 8192)
		for {
			n, readErr := ptmx.Read(buf)
			if n > 0 {
				encoded := base64.StdEncoding.EncodeToString(buf[:n])
				wailsRuntime.EventsEmit(ctx, "terminal:data:"+connID, encoded)
			}
			if readErr != nil {
				break
			}
		}
		wailsRuntime.EventsEmit(ctx, "terminal:closed:"+connID, nil)
	}()

	return &session{
		write: func(data []byte) error {
			return writeAll(ptmx, data)
		},
		resize: func(c, r int) error {
			return pty.Setsize(ptmx, &pty.Winsize{Cols: uint16(c), Rows: uint16(r)})
		},
		close: func() error {
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			return ptmx.Close()
		},
	}, nil
}
