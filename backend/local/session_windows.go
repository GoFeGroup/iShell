//go:build windows

package local

import (
	"context"
	"fmt"
	"io"
	"os"

	"github.com/UserExistsError/conpty"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"ishell/backend/termout"
)

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

	em := termout.New(ctx, connID)
	go func() {
		buf := make([]byte, 8192)
		for {
			n, readErr := cpty.Read(buf)
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

	go func() { _, _ = cpty.Wait(ctx) }()

	return &session{
		write: func(data []byte) error {
			return writeAll(cpty, data)
		},
		resize: func(c, r int) error {
			return cpty.Resize(c, r)
		},
		close: func() error {
			return cpty.Close()
		},
	}, nil
}
