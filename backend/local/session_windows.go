//go:build windows

package local

import (
	"context"
	"fmt"
	"io"
	"os"
	"sync"

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

	// emitClose is called by whichever goroutine first detects the process exit.
	// On Windows, ConPty reads can block indefinitely after exit without returning
	// an error, so we also trigger from cpty.Wait to guarantee the event fires.
	var once sync.Once
	emitClose := func() {
		once.Do(func() {
			em.Close() // flush buffered tail before signalling close
			wailsRuntime.EventsEmit(ctx, "terminal:closed:"+connID, nil)
		})
	}

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
		emitClose()
	}()

	go func() {
		_, _ = cpty.Wait(ctx)
		emitClose()
	}()

	return newSession(
		ctx,
		em,
		func(data []byte) error {
			return writeAll(cpty, data)
		},
		func(c, r int) error {
			return cpty.Resize(c, r)
		},
		func() error {
			return cpty.Close()
		},
	), nil
}
