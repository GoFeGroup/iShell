//go:build !windows

package local

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"runtime"

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

func startSession(ctx context.Context, connID string, cols, rows int) (*session, error) {
	shell := defaultShell()
	cmd := exec.Command(shell)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

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
			_, err := ptmx.Write(data)
			return err
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
