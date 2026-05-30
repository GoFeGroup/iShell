package ssh

import (
	"fmt"
	"os"

	gossh "golang.org/x/crypto/ssh"
)

// LoadPrivateKey parses a private key file, decrypting with passphrase if needed.
func LoadPrivateKey(path, passphrase string) (gossh.Signer, error) {
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
