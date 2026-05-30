package ssh

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	gossh "golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// KnownHostEntry represents one entry in known_hosts.
type KnownHostEntry struct {
	Hostname    string `json:"hostname"`
	KeyType     string `json:"key_type"`
	Fingerprint string `json:"fingerprint"`
}

// DefaultKnownHostsPath returns the platform default path.
func DefaultKnownHostsPath() string {
	home, _ := os.UserHomeDir()
	if runtime.GOOS == "windows" {
		return filepath.Join(home, ".ssh", "known_hosts")
	}
	return filepath.Join(home, ".ssh", "known_hosts")
}

// HostKeyCallback builds a callback that checks against the known_hosts file.
// If the file doesn't exist it is created as empty.
func HostKeyCallback(khPath string) (gossh.HostKeyCallback, error) {
	if khPath == "" {
		khPath = DefaultKnownHostsPath()
	}
	dir := filepath.Dir(khPath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	// Create file if missing
	if _, err := os.Stat(khPath); os.IsNotExist(err) {
		f, err := os.Create(khPath)
		if err != nil {
			return nil, err
		}
		f.Close()
	}
	cb, err := knownhosts.New(khPath)
	if err != nil {
		return nil, fmt.Errorf("parse known_hosts: %w", err)
	}
	return cb, nil
}

// AddHostKey appends a new host key to the known_hosts file.
func AddHostKey(khPath, host string, key gossh.PublicKey) error {
	if khPath == "" {
		khPath = DefaultKnownHostsPath()
	}
	f, err := os.OpenFile(khPath, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	line := knownhosts.Line([]string{host}, key)
	_, err = fmt.Fprintln(f, line)
	return err
}

// ListKnownHosts returns parsed entries from the known_hosts file.
func ListKnownHosts(khPath string) ([]KnownHostEntry, error) {
	if khPath == "" {
		khPath = DefaultKnownHostsPath()
	}
	f, err := os.Open(khPath)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var entries []KnownHostEntry
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) < 3 {
			continue
		}
		entries = append(entries, KnownHostEntry{
			Hostname: parts[0],
			KeyType:  parts[1],
			// Show a short fingerprint from the raw key material
			Fingerprint: parts[2][:min(16, len(parts[2]))] + "…",
		})
	}
	return entries, scanner.Err()
}

// RemoveKnownHost removes lines matching hostname from known_hosts.
func RemoveKnownHost(khPath, hostname string) error {
	if khPath == "" {
		khPath = DefaultKnownHostsPath()
	}
	data, err := os.ReadFile(khPath)
	if err != nil {
		return err
	}
	var kept []string
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(strings.TrimSpace(line), hostname) {
			kept = append(kept, line)
		}
	}
	return os.WriteFile(khPath, []byte(strings.Join(kept, "\n")), 0600)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
