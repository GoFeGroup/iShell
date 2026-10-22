//go:build !windows

package local

import (
	"encoding/base64"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ishell/backend/termout"
)

type ptyHarness struct {
	proc   *ptyProcess
	mu     sync.Mutex
	out    []byte
	closed atomic.Int32
	// outAtClose is the output observed when onClosed fired.
	outAtClose string
}

func startTestPTY(t *testing.T, script string) *ptyHarness {
	t.Helper()
	h := &ptyHarness{}
	em := termout.NewWithSink("test", func(_ string, data string) {
		decoded, err := base64.StdEncoding.DecodeString(data)
		if err != nil {
			t.Errorf("decode output: %v", err)
			return
		}
		h.mu.Lock()
		h.out = append(h.out, decoded...)
		h.mu.Unlock()
	})
	proc, err := startPTY(exec.Command("/bin/sh", "-c", script), 80, 24, em, func() {
		h.mu.Lock()
		h.outAtClose = string(h.out)
		h.mu.Unlock()
		h.closed.Add(1)
	})
	if err != nil {
		t.Fatalf("startPTY: %v", err)
	}
	h.proc = proc
	t.Cleanup(func() { _ = proc.Close() })
	return h
}

func waitClosed(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

func assertReaped(t *testing.T, h *ptyHarness) {
	t.Helper()
	waitClosed(t, h.proc.processDone, "process reap")
	waitClosed(t, h.proc.finished, "close notification")
	if h.proc.cmd.ProcessState == nil {
		t.Fatal("child exit status was not collected (zombie)")
	}
	if n := h.closed.Load(); n != 1 {
		t.Fatalf("onClosed fired %d times, want 1", n)
	}
}

func TestPTYNaturalExitReapsAndKeepsTail(t *testing.T) {
	h := startTestPTY(t, "printf 'hello-tail-marker'; exit 3")
	assertReaped(t, h)

	if code := h.proc.cmd.ProcessState.ExitCode(); code != 3 {
		t.Fatalf("exit code = %d, want 3", code)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if !strings.Contains(h.outAtClose, "hello-tail-marker") {
		t.Fatalf("output at close = %q, want tail flushed before close event", h.outAtClose)
	}
}

func TestPTYNaturalExitWithLingeringDescendant(t *testing.T) {
	// The background sleep keeps the PTY slave open after the shell exits, so
	// the reader never sees EOF on its own. Reaping must not depend on it.
	h := startTestPTY(t, "printf 'bye'; sleep 3 & exit 0")
	assertReaped(t, h)

	h.mu.Lock()
	defer h.mu.Unlock()
	if !strings.Contains(h.outAtClose, "bye") {
		t.Fatalf("output at close = %q, want tail flushed", h.outAtClose)
	}
}

func TestPTYActiveCloseReaps(t *testing.T) {
	h := startTestPTY(t, "sleep 30")
	if err := h.proc.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	select {
	case <-h.proc.processDone:
	default:
		t.Fatal("Close returned before the child was reaped")
	}
	assertReaped(t, h)
}

func TestPTYConcurrentClose(t *testing.T) {
	h := startTestPTY(t, "sleep 30")
	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = h.proc.Close()
		}()
	}
	wg.Wait()
	assertReaped(t, h)
	_ = h.proc.Close() // idempotent after completion
}

func TestPTYRepeatedStartCloseLeavesNoZombies(t *testing.T) {
	harnesses := make([]*ptyHarness, 0, 30)
	for i := range 30 {
		script := "sleep 30"
		if i%2 == 1 {
			script = "exit 0" // mix natural exits with explicit closes
		}
		h := startTestPTY(t, script)
		if i%2 == 0 {
			_ = h.proc.Close()
		}
		harnesses = append(harnesses, h)
	}
	for _, h := range harnesses {
		assertReaped(t, h)
	}
}
