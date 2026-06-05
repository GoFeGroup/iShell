package ssh

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	gossh "golang.org/x/crypto/ssh"
)

const DefaultPrivateKeyPath = "~/.ssh/id_rsa"

func expandUserPath(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", nil
	}
	if path != "~" && !strings.HasPrefix(path, "~/") && !strings.HasPrefix(path, `~\`) {
		return path, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory: %w", err)
	}
	if path == "~" {
		return home, nil
	}
	return filepath.Join(home, filepath.FromSlash(path[2:])), nil
}

// LoadPrivateKey parses a private key file, decrypting with passphrase if needed.
func LoadPrivateKey(path, passphrase string) (gossh.Signer, error) {
	path, err := expandUserPath(path)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read key file: %w", err)
	}
	if passphrase != "" {
		signer, err := gossh.ParsePrivateKeyWithPassphrase(data, []byte(passphrase))
		if err != nil {
			return nil, fmt.Errorf("parse key with passphrase: %w", err)
		}
		return signer, nil
	}
	signer, err := gossh.ParsePrivateKey(data)
	if err != nil {
		return nil, fmt.Errorf("parse key: %w", err)
	}
	return signer, nil
}

// ValidateKey returns true when the key can be parsed successfully.
func ValidateKey(path, passphrase string) (bool, error) {
	_, err := LoadPrivateKey(path, passphrase)
	return err == nil, err
}
