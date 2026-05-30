package main

import (
	"fmt"
	"io"
	"strings"
	"time"

	gossh "golang.org/x/crypto/ssh"
)

func main() {
	cfg := &gossh.ClientConfig{
		User:            "root",
		Auth:            []gossh.AuthMethod{gossh.Password("1qaz@WSX")},
		HostKeyCallback: gossh.InsecureIgnoreHostKey(),
		Timeout:         10 * time.Second,
	}
	client, err := gossh.Dial("tcp", "10.226.233.236:22", cfg)
	if err != nil {
		panic(err)
	}
	defer client.Close()

	sess, err := client.NewSession()
	if err != nil {
		panic(err)
	}
	defer sess.Close()

	modes := gossh.TerminalModes{gossh.ECHO: 1, gossh.TTY_OP_ISPEED: 14400, gossh.TTY_OP_OSPEED: 14400}
	sess.RequestPty("xterm-256color", 50, 220, modes)

	stdin, _ := sess.StdinPipe()
	stdout, _ := sess.StdoutPipe()
	sess.Shell()

	// Collect output in background
	var outBuf strings.Builder
	done := make(chan struct{})
	go func() {
		io.Copy(&outBuf, stdout)
		close(done)
	}()

	time.Sleep(500 * time.Millisecond) // wait for shell prompt

	// Simulate fast typing: send each char individually with 5ms gap
	// (simulating the Wails IPC round-trip delay)
	chars := []string{"e", "c", "h", "o", " ", "h", "e", "l", "l", "o", "\r"}
	fmt.Printf("Sending %d chars with 5ms gap each...\n", len(chars))
	for i, c := range chars {
		stdin.Write([]byte(c))
		fmt.Printf("  sent[%d]: %q\n", i, c)
		time.Sleep(5 * time.Millisecond) // simulate per-IPC-call delay
	}

	time.Sleep(300 * time.Millisecond)

	// Now send with 0ms gap (concurrent-like)
	fmt.Println("\nSending 'whoami\\r' with 0ms gap...")
	for _, c := range []string{"w", "h", "o", "a", "m", "i", "\r"} {
		stdin.Write([]byte(c))
	}
	time.Sleep(300 * time.Millisecond)

	stdin.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
	}

	out := outBuf.String()
	fmt.Printf("\n=== Output received (%d bytes) ===\n", len(out))
	// Strip control chars for readability
	var readable strings.Builder
	for _, r := range out {
		if r >= 32 && r < 127 || r == '\n' {
			readable.WriteRune(r)
		} else if r == '\r' {
			readable.WriteRune('\n')
		}
	}
	fmt.Println(readable.String())

	if strings.Contains(out, "hello") {
		fmt.Println("✅ echo hello: RECEIVED")
	} else {
		fmt.Println("❌ echo hello: MISSING")
	}
	if strings.Contains(out, "root") {
		fmt.Println("✅ whoami: RECEIVED")
	} else {
		fmt.Println("❌ whoami: MISSING")
	}
}
