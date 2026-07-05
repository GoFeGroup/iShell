//go:build windows

package ssh

import (
	"fmt"
	"io"

	pageant "github.com/davidmz/go-pageant"
	"golang.org/x/crypto/ssh/agent"
)

// DialAgent connects to Pageant, PuTTY's SSH agent and the de facto standard
// on Windows (there is no SSH_AUTH_SOCK/Unix-domain-socket agent by default).
// Pageant has no persistent connection to hold open — each request is a
// one-shot Windows IPC call — so the returned io.Closer is always nil.
func DialAgent() (agent.Agent, io.Closer, error) {
	if !pageant.Available() {
		return nil, nil, fmt.Errorf("Pageant is not running — start Pageant (or PuTTY/KiTTY's agent) and load a key")
	}
	return pageant.New(), nil, nil
}
