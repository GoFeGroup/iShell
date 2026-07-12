package ssh

import (
	"testing"

	"golang.org/x/crypto/ssh/knownhosts"
)

func TestKnownHostsLineMatches(t *testing.T) {
	hashed := knownhosts.HashHostname("secret.example")
	tests := []struct {
		name, line, hostname string
		want                 bool
	}{
		{"exact", "host.example ssh-ed25519 AAAA", "host.example", true},
		{"comma separated alias", "primary.example,alias.example ssh-ed25519 AAAA", "alias.example", true},
		{"hashed", hashed + " ssh-ed25519 AAAA", "secret.example", true},
		{"prefix is not exact", "host.example.net ssh-ed25519 AAAA", "host.example", false},
		{"comment", "# host.example ssh-ed25519 AAAA", "host.example", false},
		{"blank", "  ", "host.example", false},
		{"invalid hash encoding", "|1|not-base64|still-not-base64 ssh-ed25519 AAAA", "host.example", false},
		{"unsupported hash version", "|2|YWJj|ZGVm ssh-ed25519 AAAA", "host.example", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := knownHostsLineMatches(tt.line, tt.hostname); got != tt.want {
				t.Fatalf("knownHostsLineMatches(%q, %q) = %v, want %v", tt.line, tt.hostname, got, tt.want)
			}
		})
	}
}
