package ssh

import (
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"path/filepath"
	"testing"

	gossh "golang.org/x/crypto/ssh"
)

func mustTestSigner(t *testing.T) gossh.Signer {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	signer, err := gossh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("new signer: %v", err)
	}
	return signer
}

func TestDefaultKnownHostsPathIsUnderHomeSSHDir(t *testing.T) {
	home := t.TempDir()
	setTestHome(t, home)

	got := DefaultKnownHostsPath()
	want := filepath.Join(home, ".ssh", "known_hosts")
	if got != want {
		t.Fatalf("DefaultKnownHostsPath() = %q, want %q", got, want)
	}
}

func TestHostKeyCallbackCreatesMissingFileAndDirs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "known_hosts")

	cb, err := HostKeyCallback(path)
	if err != nil {
		t.Fatalf("HostKeyCallback: %v", err)
	}
	if cb == nil {
		t.Fatal("expected a non-nil callback")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected known_hosts file to be created: %v", err)
	}
}

func TestHostKeyCallbackAcceptsKeyAddedByAddHostKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "known_hosts")
	signer := mustTestSigner(t)

	if err := AddHostKey(path, "example.com:22", signer.PublicKey()); err != nil {
		t.Fatalf("AddHostKey: %v", err)
	}

	cb, err := HostKeyCallback(path)
	if err != nil {
		t.Fatalf("HostKeyCallback: %v", err)
	}
	if err := cb("example.com:22", &fakeAddr{}, signer.PublicKey()); err != nil {
		t.Fatalf("expected known key to be accepted, got: %v", err)
	}

	other := mustTestSigner(t)
	if err := cb("example.com:22", &fakeAddr{}, other.PublicKey()); err == nil {
		t.Fatal("expected an unknown key for a known host to be rejected")
	}
}

type fakeAddr struct{}

func (*fakeAddr) Network() string { return "tcp" }
func (*fakeAddr) String() string  { return "example.com:22" }

func TestListKnownHostsParsesEntriesAndSkipsNoise(t *testing.T) {
	path := filepath.Join(t.TempDir(), "known_hosts")
	signer := mustTestSigner(t)
	line := gosshMarshalAuthorizedKeyLine(t, "host.example", signer.PublicKey())
	content := "# a comment\n\n" + line + "malformed-line-with-only-one-field\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	entries, err := ListKnownHosts(path)
	if err != nil {
		t.Fatalf("ListKnownHosts: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d: %+v", len(entries), entries)
	}
	if entries[0].Hostname != "host.example" {
		t.Fatalf("Hostname = %q, want host.example", entries[0].Hostname)
	}
	if entries[0].KeyType != signer.PublicKey().Type() {
		t.Fatalf("KeyType = %q, want %q", entries[0].KeyType, signer.PublicKey().Type())
	}
}

func TestListKnownHostsMissingFileReturnsEmptyWithoutError(t *testing.T) {
	entries, err := ListKnownHosts(filepath.Join(t.TempDir(), "missing"))
	if err != nil {
		t.Fatalf("ListKnownHosts: unexpected error %v", err)
	}
	if entries != nil {
		t.Fatalf("expected no entries, got %+v", entries)
	}
}

func gosshMarshalAuthorizedKeyLine(t *testing.T, host string, key gossh.PublicKey) string {
	t.Helper()
	// knownhosts.Line produces "host keytype base64key"; reuse it via
	// AddHostKey against a scratch file, then read the single line back.
	path := filepath.Join(t.TempDir(), "scratch")
	if err := AddHostKey(path, host, key); err != nil {
		t.Fatalf("AddHostKey: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
