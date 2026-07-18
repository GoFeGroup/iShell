package ssh

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"

	gossh "golang.org/x/crypto/ssh"
)

func writeTestKey(t *testing.T, dir, name, passphrase string) string {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	var block *pem.Block
	if passphrase != "" {
		block, err = gossh.MarshalPrivateKeyWithPassphrase(priv, "", []byte(passphrase))
	} else {
		block, err = gossh.MarshalPrivateKey(priv, "")
	}
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, pem.EncodeToMemory(block), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadPrivateKeyUnencrypted(t *testing.T) {
	dir := t.TempDir()
	path := writeTestKey(t, dir, "id_ed25519", "")

	signer, err := LoadPrivateKey(path, "")
	if err != nil {
		t.Fatalf("LoadPrivateKey: %v", err)
	}
	if signer == nil {
		t.Fatal("expected a non-nil signer")
	}
}

func TestLoadPrivateKeyWithCorrectPassphrase(t *testing.T) {
	dir := t.TempDir()
	path := writeTestKey(t, dir, "id_ed25519", "s3cret")

	signer, err := LoadPrivateKey(path, "s3cret")
	if err != nil {
		t.Fatalf("LoadPrivateKey: %v", err)
	}
	if signer == nil {
		t.Fatal("expected a non-nil signer")
	}
}

func TestLoadPrivateKeyWithWrongPassphraseFails(t *testing.T) {
	dir := t.TempDir()
	path := writeTestKey(t, dir, "id_ed25519", "s3cret")

	if _, err := LoadPrivateKey(path, "wrong"); err == nil {
		t.Fatal("expected an error for a wrong passphrase")
	}
}

func TestLoadPrivateKeyMissingFile(t *testing.T) {
	if _, err := LoadPrivateKey(filepath.Join(t.TempDir(), "missing"), ""); err == nil {
		t.Fatal("expected an error for a missing key file")
	}
}

func TestLoadPrivateKeyExpandsHomeDirectory(t *testing.T) {
	home := t.TempDir()
	setTestHome(t, home)
	if err := os.MkdirAll(filepath.Join(home, ".ssh"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeTestKey(t, filepath.Join(home, ".ssh"), "id_ed25519", "")

	if _, err := LoadPrivateKey("~/.ssh/id_ed25519", ""); err != nil {
		t.Fatalf("LoadPrivateKey with ~ path: %v", err)
	}
}

func TestValidateKeyReportsValidityWithoutPanicking(t *testing.T) {
	dir := t.TempDir()
	goodPath := writeTestKey(t, dir, "good", "")
	badPath := filepath.Join(dir, "bad")
	if err := os.WriteFile(badPath, []byte("not a key"), 0o600); err != nil {
		t.Fatal(err)
	}

	if ok, err := ValidateKey(goodPath, ""); !ok || err != nil {
		t.Fatalf("ValidateKey(good) = (%v, %v), want (true, nil)", ok, err)
	}
	if ok, err := ValidateKey(badPath, ""); ok || err == nil {
		t.Fatalf("ValidateKey(bad) = (%v, %v), want (false, non-nil)", ok, err)
	}
}
