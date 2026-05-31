//go:build windows

package local

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

func startSession(ctx context.Context, connID string, _ int, _ int) (*session, error) {
	cmd := exec.Command("powershell.exe", "-NoLogo", "-NoProfile")
	cmd.Env = os.Environ()
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}

	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("create stdin pipe: %w", err)
	}
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		stdinR.Close()
		stdinW.Close()
		return nil, fmt.Errorf("create stdout pipe: %w", err)
	}

	cmd.Stdin = stdinR
	cmd.Stdout = stdoutW
	cmd.Stderr = stdoutW

	if err := cmd.Start(); err != nil {
		stdinR.Close()
		stdinW.Close()
		stdoutR.Close()
		stdoutW.Close()
		return nil, fmt.Errorf("start powershell: %w", err)
	}
	stdinR.Close()
	stdoutW.Close()

	go func() {
		buf := make([]byte, 8192)
		for {
			n, readErr := stdoutR.Read(buf)
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

	go func() { _ = cmd.Wait() }()

	return &session{
		write: func(data []byte) error {
			_, err := stdinW.Write(data)
			return err
		},
		resize: func(c, r int) error {
			return nil
		},
		close: func() error {
			stdinW.Close()
			stdoutR.Close()
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			return nil
		},
	}, nil
}
