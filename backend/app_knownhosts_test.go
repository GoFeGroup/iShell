package backend

import "testing"

func TestKnownHostsPathWithoutStore(t *testing.T) {
	app := NewApp()
	if got := app.knownHostsPath(); got != "" {
		t.Fatalf("knownHostsPath() = %q, want empty path when store is unavailable", got)
	}
}
