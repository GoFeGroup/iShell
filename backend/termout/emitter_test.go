package termout

import (
	"encoding/base64"
	"sync"
	"testing"
	"time"
)

// newTestEmitter returns an Emitter whose sink decodes each flushed chunk and
// appends the bytes to *out under mu, so tests can assert nothing is lost.
func newTestEmitter(out *[]byte, mu *sync.Mutex) *Emitter {
	return &Emitter{
		event: "terminal:data:test",
		sink: func(_ string, data string) {
			decoded, err := base64.StdEncoding.DecodeString(data)
			if err != nil {
				panic(err)
			}
			mu.Lock()
			*out = append(*out, decoded...)
			mu.Unlock()
		},
	}
}

func TestEmitterCoalescesAndPreservesBytes(t *testing.T) {
	var out []byte
	var mu sync.Mutex
	e := newTestEmitter(&out, &mu)

	want := make([]byte, 0, 1000)
	for i := range 1000 {
		b := []byte{byte(i % 256)}
		want = append(want, b...)
		e.Write(b)
	}
	e.Close()

	mu.Lock()
	defer mu.Unlock()
	if string(out) != string(want) {
		t.Fatalf("byte stream mismatch: got %d bytes, want %d", len(out), len(want))
	}
}

func TestEmitterThresholdFlush(t *testing.T) {
	var out []byte
	var mu sync.Mutex
	e := newTestEmitter(&out, &mu)

	// A single write larger than maxBuf must flush immediately (no timer wait).
	big := make([]byte, maxBuf+512)
	for i := range big {
		big[i] = byte(i)
	}
	e.Write(big)

	mu.Lock()
	got := len(out)
	mu.Unlock()
	if got != len(big) {
		t.Fatalf("threshold flush did not emit immediately: got %d of %d bytes", got, len(big))
	}
	e.Close()
}

// TestEmitterConcurrentWritePreservesAllBytes mirrors SSH's stdout+stderr
// readers writing the same Emitter concurrently: every byte must survive.
func TestEmitterConcurrentWritePreservesAllBytes(t *testing.T) {
	var out []byte
	var mu sync.Mutex
	e := newTestEmitter(&out, &mu)

	const writers = 4
	const perWriter = 500
	var wg sync.WaitGroup
	for w := range writers {
		wg.Add(1)
		go func(id byte) {
			defer wg.Done()
			for range perWriter {
				e.Write([]byte{id})
			}
		}(byte(w))
	}
	wg.Wait()
	// Allow any pending timer flush to run, then close to flush the tail.
	time.Sleep(2 * flushDelay)
	e.Close()

	mu.Lock()
	defer mu.Unlock()
	if len(out) != writers*perWriter {
		t.Fatalf("lost bytes under concurrent write: got %d, want %d", len(out), writers*perWriter)
	}
}

func TestEmitterClosedDropsWrites(t *testing.T) {
	var out []byte
	var mu sync.Mutex
	e := newTestEmitter(&out, &mu)
	e.Close()
	e.Write([]byte("ignored"))

	mu.Lock()
	defer mu.Unlock()
	if len(out) != 0 {
		t.Fatalf("write after close should be dropped, got %q", out)
	}
}
