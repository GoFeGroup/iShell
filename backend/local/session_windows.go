//go:build windows

package local

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"

	"github.com/UserExistsError/conpty"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

func startSession(ctx context.Context, connID string, cols, rows int) (*session, error) {
	if cols <= 0 {
		cols = 220
	}
	if rows <= 0 {
		rows = 50
	}
	workDir := ""
	if home, err := os.UserHomeDir(); err == nil {
		workDir = home
	}

	cpty, err := conpty.Start(
		"powershell.exe -NoLogo -NoProfile",
		conpty.ConPtyDimensions(cols, rows),
		conpty.ConPtyWorkDir(workDir),
		conpty.ConPtyEnv(os.Environ()),
	)
	if err != nil {
		return nil, fmt.Errorf("start powershell conpty: %w", err)
	}

	go func() {
		buf := make([]byte, 8192)
		for {
			n, readErr := cpty.Read(buf)
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

	go func() { _, _ = cpty.Wait(ctx) }()

	return &session{
		write: func(data []byte) error {
			_, err := cpty.Write(data)
			return err
		},
		resize: func(c, r int) error {
			return cpty.Resize(c, r)
		},
		close: func() error {
			return cpty.Close()
		},
	}, nil
}
