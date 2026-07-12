package ssh

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh/knownhosts"
)

func TestRemoveKnownHostMatchesExactAndHashedHosts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "known_hosts")
	hashed := knownhosts.HashHostname("hidden.example:22")
	content := strings.Join([]string{
		"10.0.0.1 ssh-ed25519 AAAA",
		"10.0.0.10 ssh-ed25519 AAAB",
		"primary.example,alias.example ssh-ed25519 AAAC",
		hashed + " ssh-ed25519 AAAD",
		"",
	}, "\n")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	for _, hostname := range []string{"10.0.0.1", "alias.example", "hidden.example:22"} {
		if err := RemoveKnownHost(path, hostname); err != nil {
			t.Fatalf("RemoveKnownHost(%q): %v", hostname, err)
		}
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	if !strings.Contains(got, "10.0.0.10 ") {
		t.Fatalf("prefix-neighbor entry was removed:\n%s", got)
	}
	for _, removed := range []string{"10.0.0.1 ", "primary.example,alias.example", hashed} {
		if strings.Contains(got, removed) {
			t.Fatalf("entry %q was not removed:\n%s", removed, got)
		}
	}
}
