//go:build !windows

package ssh

import (
	"fmt"
	"io"
	"net"
	"os"

	"golang.org/x/crypto/ssh/agent"
)

// DialAgent connects to the running SSH agent via SSH_AUTH_SOCK and returns
// an agent.Agent usable for both key-based auth (Signers) and forwarding
// (agent.ForwardToAgent). The returned io.Closer must be closed when the SSH
// connection using it is torn down.
func DialAgent() (agent.Agent, io.Closer, error) {
	sock := os.Getenv("SSH_AUTH_SOCK")
	if sock == "" {
		return nil, nil, fmt.Errorf("SSH_AUTH_SOCK is not set — is an SSH agent running?")
	}
	conn, err := net.Dial("unix", sock)
	if err != nil {
		return nil, nil, fmt.Errorf("dial ssh agent: %w", err)
	}
	return agent.NewClient(conn), conn, nil
}
