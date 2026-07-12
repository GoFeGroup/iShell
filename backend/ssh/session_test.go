package ssh

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type recordingWriteCloser struct {
	mu     sync.Mutex
	writes [][]byte
	wrote  chan struct{}
}

func (w *recordingWriteCloser) Write(p []byte) (int, error) {
	w.mu.Lock()
	w.writes = append(w.writes, append([]byte(nil), p...))
	w.mu.Unlock()
	select {
	case w.wrote <- struct{}{}:
	default:
	}
	return len(p), nil
}

func (w *recordingWriteCloser) Close() error { return nil }

func TestTermSessionWriteCopiesInputBeforeEnqueue(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w := &recordingWriteCloser{wrote: make(chan struct{}, 1)}
	ts := &TermSession{
		stdin:   w,
		inputCh: make(chan []byte, 1),
		ctx:     ctx,
	}

	input := []byte("original")
	if err := ts.Write(input); err != nil {
		t.Fatalf("Write: %v", err)
	}
	copy(input, "mutated!")
	go ts.pumpInput()

	select {
	case <-w.wrote:
	case <-time.After(time.Second):
		t.Fatal("queued input was not written")
	}
	cancel()

	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.writes) != 1 || string(w.writes[0]) != "original" {
		t.Fatalf("writes = %q, want one copied input %q", w.writes, "original")
	}
}

func TestTermSessionWriteReturnsContextErrorAfterCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	ts := &TermSession{
		inputCh: make(chan []byte),
		ctx:     ctx,
	}

	err := ts.Write([]byte("ignored"))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Write error = %v, want context.Canceled", err)
	}
}

func TestTermSessionPumpInputStopsWhenCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	ts := &TermSession{
		stdin:   &recordingWriteCloser{wrote: make(chan struct{}, 1)},
		inputCh: make(chan []byte),
		ctx:     ctx,
	}
	done := make(chan struct{})
	go func() {
		ts.pumpInput()
		close(done)
	}()

	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("pumpInput did not stop after context cancellation")
	}
}
