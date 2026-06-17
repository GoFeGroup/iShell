package local

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSendInputCopiesAndPreservesOrder(t *testing.T) {
	writes := make(chan string, 2)
	sess := newSession(
		context.Background(),
		func(data []byte) error {
			writes <- string(data)
			return nil
		},
		func(_, _ int) error { return nil },
		func() error { return nil },
	)
	mgr := &Manager{sessions: map[string]*session{"local-test": sess}}

	first := []byte("one")
	if err := mgr.SendInput("local-test", first); err != nil {
		t.Fatalf("SendInput(first): %v", err)
	}
	copy(first, "xxx")
	if err := mgr.SendInput("local-test", []byte("two")); err != nil {
		t.Fatalf("SendInput(second): %v", err)
	}

	for _, want := range []string{"one", "two"} {
		select {
		case got := <-writes:
			if got != want {
				t.Fatalf("write = %q, want %q", got, want)
			}
		case <-time.After(time.Second):
			t.Fatalf("timed out waiting for write %q", want)
		}
	}
}

func TestSendInputReturnsBeforeWriterCompletes(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	sess := newSession(
		context.Background(),
		func([]byte) error {
			close(started)
			<-release
			return nil
		},
		func(_, _ int) error { return nil },
		func() error { return nil },
	)
	t.Cleanup(func() {
		close(release)
		_ = sess.close()
	})
	mgr := &Manager{sessions: map[string]*session{"local-test": sess}}

	done := make(chan error, 1)
	go func() {
		done <- mgr.SendInput("local-test", []byte("large paste"))
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("SendInput returned error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("SendInput blocked until the writer completed")
	}

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("writer did not receive queued input")
	}
}

func TestSendInputReportsWriterError(t *testing.T) {
	writeErr := errors.New("pty write failed")
	wrote := make(chan struct{})
	sess := newSession(
		context.Background(),
		func([]byte) error {
			close(wrote)
			return writeErr
		},
		func(_, _ int) error { return nil },
		func() error { return nil },
	)
	mgr := &Manager{sessions: map[string]*session{"local-test": sess}}

	if err := mgr.SendInput("local-test", []byte("first")); err != nil {
		t.Fatalf("SendInput(first): %v", err)
	}
	select {
	case <-wrote:
	case <-time.After(time.Second):
		t.Fatal("writer was not called")
	}

	deadline := time.After(time.Second)
	for {
		err := mgr.SendInput("local-test", []byte("second"))
		if errors.Is(err, writeErr) {
			return
		}
		if err != nil {
			t.Fatalf("SendInput(second) = %v, want %v", err, writeErr)
		}
		select {
		case <-deadline:
			t.Fatalf("SendInput(second) did not report writer error")
		default:
			time.Sleep(time.Millisecond)
		}
	}
}

func TestSendInputAfterCloseReturnsContextError(t *testing.T) {
	sess := newSession(
		context.Background(),
		func([]byte) error { return nil },
		func(_, _ int) error { return nil },
		func() error { return nil },
	)
	mgr := &Manager{sessions: map[string]*session{"local-test": sess}}
	if err := sess.close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	err := mgr.SendInput("local-test", []byte("ignored"))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("SendInput after close = %v, want context.Canceled", err)
	}
}

func TestManagerReportsUnknownLocalSession(t *testing.T) {
	mgr := &Manager{sessions: map[string]*session{}}

	if err := mgr.SendInput("missing", []byte("x")); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("SendInput missing session = %v, want not found error", err)
	}
	if err := mgr.ResizeTerminal("missing", 80, 24); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("ResizeTerminal missing session = %v, want not found error", err)
	}
	if err := mgr.Disconnect("missing"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("Disconnect missing session = %v, want not found error", err)
	}
}

func TestResizeTerminalDelegatesToSession(t *testing.T) {
	var gotCols atomic.Int32
	var gotRows atomic.Int32
	sess := newSession(
		context.Background(),
		func([]byte) error { return nil },
		func(cols, rows int) error {
			gotCols.Store(int32(cols))
			gotRows.Store(int32(rows))
			return nil
		},
		func() error { return nil },
	)
	mgr := &Manager{sessions: map[string]*session{"local-test": sess}}

	if err := mgr.ResizeTerminal("local-test", 132, 43); err != nil {
		t.Fatalf("ResizeTerminal: %v", err)
	}
	if gotCols.Load() != 132 || gotRows.Load() != 43 {
		t.Fatalf("resize got %dx%d, want 132x43", gotCols.Load(), gotRows.Load())
	}
}

func TestDisconnectRemovesSessionAndClosesIt(t *testing.T) {
	var closed atomic.Bool
	sess := newSession(
		context.Background(),
		func([]byte) error { return nil },
		func(_, _ int) error { return nil },
		func() error {
			closed.Store(true)
			return nil
		},
	)
	mgr := &Manager{sessions: map[string]*session{"local-test": sess}}

	if err := mgr.Disconnect("local-test"); err != nil {
		t.Fatalf("Disconnect: %v", err)
	}
	if !closed.Load() {
		t.Fatal("Disconnect did not close the session")
	}
	if mgr.Has("local-test") {
		t.Fatal("Disconnect did not remove the session")
	}
}
