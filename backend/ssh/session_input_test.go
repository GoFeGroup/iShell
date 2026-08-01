package ssh

import (
	"context"
	"errors"
	"testing"
	"time"
)

type failingWriteCloser struct{}

func (failingWriteCloser) Write([]byte) (int, error) { return 0, errors.New("stdin broken") }
func (failingWriteCloser) Close() error              { return nil }

// TestWriteFailsFastAfterStdinError guards against Write blocking forever
// once the SSH stdin pipe has died: pumpInput must cancel the session ctx on
// a write error so queued and future Write callers (Wails IPC goroutines)
// return an error instead of hanging until Disconnect.
func TestWriteFailsFastAfterStdinError(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ts := &TermSession{
		connID:  "test",
		stdin:   failingWriteCloser{},
		inputCh: make(chan []byte, 2),
		ctx:     ctx,
		cancel:  cancel,
	}
	go ts.pumpInput()

	done := make(chan error, 1)
	go func() {
		// The first write triggers the stdin error inside pumpInput; later
		// writes must eventually fail instead of blocking on a full inputCh.
		var err error
		for range 16 {
			err = ts.Write([]byte("x"))
			if err != nil {
				break
			}
		}
		done <- err
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("Write kept succeeding after stdin write error")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Write blocked after stdin write error")
	}
}
