package backend

// Covers the connOrder mechanism that App.ListTerminals relies on to return
// terminals in a stable, deterministic order (see connOrder's doc comment on
// the App struct). These tests exercise appendConnOrder/removeConnOrder
// directly rather than going through Connect/ConnectLocal, because a real
// ConnectLocal spawns an actual local shell and emits Wails runtime events
// that panic outside a live Wails app (see mcpserver_app_test.go) — the same
// reason existing ssh/local manager tests build sessions by hand instead of
// dialing real connections.

import (
	"context"
	"sync"
	"testing"

	"ishell/backend/local"
	"ishell/backend/ssh"
)

func newTestApp() *App {
	ctx := context.Background()
	return &App{
		sshMgr:   ssh.NewManager(ctx, nil),
		localMgr: local.NewManager(ctx),
	}
}

func TestConnOrderPreservesInsertionOrder(t *testing.T) {
	app := newTestApp()

	app.appendConnOrder("first")
	app.appendConnOrder("second")
	app.appendConnOrder("third")

	got := append([]string(nil), app.connOrder...)
	want := []string{"first", "second", "third"}
	if len(got) != len(want) {
		t.Fatalf("connOrder = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("connOrder = %v, want %v", got, want)
		}
	}
}

func TestRemoveConnOrderDropsOnlyTheDisconnectedEntry(t *testing.T) {
	app := newTestApp()
	app.appendConnOrder("first")
	app.appendConnOrder("second")
	app.appendConnOrder("third")

	app.removeConnOrder("second")

	got := append([]string(nil), app.connOrder...)
	want := []string{"first", "third"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("connOrder after removal = %v, want %v", got, want)
	}
}

func TestRemoveConnOrderUnknownIDIsANoOp(t *testing.T) {
	app := newTestApp()
	app.appendConnOrder("first")

	app.removeConnOrder("never-added")

	if len(app.connOrder) != 1 || app.connOrder[0] != "first" {
		t.Fatalf("connOrder = %v, want [first] unchanged", app.connOrder)
	}
}

// TestConnOrderIsRaceSafe guards against the Go map randomization bug this
// mechanism replaces coming back in a different form: concurrent
// Connect/Disconnect calls (as happen when the frontend opens/closes tabs
// quickly) must not corrupt connOrder. Run with -race to catch data races.
func TestConnOrderIsRaceSafe(t *testing.T) {
	app := newTestApp()
	const n = 50

	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := string(rune('a' + i%26))
			app.appendConnOrder(id)
			app.removeConnOrder(id)
		}(i)
	}
	wg.Wait()
}

// TestListTerminalsSkipsStaleConnOrderEntries verifies that a connID present
// in connOrder but no longer known to either manager (a benign race between
// a concurrent Disconnect and ListTerminals, see the "ok" check in
// App.ListTerminals) is silently skipped rather than producing a malformed
// entry or a panic.
func TestListTerminalsSkipsStaleConnOrderEntries(t *testing.T) {
	app := newTestApp()
	app.appendConnOrder("ghost-conn")

	got := app.ListTerminals()
	if len(got) != 0 {
		t.Fatalf("ListTerminals() = %v, want empty (stale entry should be skipped)", got)
	}
}
