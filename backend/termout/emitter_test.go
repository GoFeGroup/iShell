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

func TestEmitterSnapshotSmallerThanCapacity(t *testing.T) {
	var out []byte
	var mu sync.Mutex
	e := newTestEmitter(&out, &mu)

	e.Write([]byte("hello "))
	e.Write([]byte("world"))

	data, offset := e.Snapshot()
	if string(data) != "hello world" {
		t.Fatalf("snapshot = %q, want %q", data, "hello world")
	}
	if offset != int64(len("hello world")) {
		t.Fatalf("offset = %d, want %d", offset, len("hello world"))
	}
	e.Close()
}

func TestEmitterSnapshotWrapsAroundCapacity(t *testing.T) {
	var out []byte
	var mu sync.Mutex
	e := newTestEmitter(&out, &mu)

	// Write more than ringCapacity total, in chunks, so the ring wraps.
	chunk := make([]byte, 1024)
	total := 0
	for total < ringCapacity+4096 {
		for i := range chunk {
			chunk[i] = byte((total + i) % 256)
		}
		e.Write(chunk)
		total += len(chunk)
	}

	data, offset := e.Snapshot()
	if len(data) != ringCapacity {
		t.Fatalf("snapshot len = %d, want %d (ring should be full)", len(data), ringCapacity)
	}
	if offset != int64(total) {
		t.Fatalf("offset = %d, want %d", offset, total)
	}
	// The snapshot must be the *last* ringCapacity bytes written, in order.
	wantFirstByte := byte((total - ringCapacity) % 256)
	if data[0] != wantFirstByte {
		t.Fatalf("snapshot[0] = %d, want %d (oldest retained byte)", data[0], wantFirstByte)
	}
	e.Close()
}

func TestEmitterSinceReturnsOnlyNewBytes(t *testing.T) {
	var out []byte
	var mu sync.Mutex
	e := newTestEmitter(&out, &mu)

	e.Write([]byte("abc"))
	_, offset := e.Snapshot()
	e.Write([]byte("def"))

	got := e.Since(offset)
	if string(got) != "def" {
		t.Fatalf("Since = %q, want %q", got, "def")
	}
	e.Close()
}

func TestEmitterSinceBeforeRetentionReturnsBestEffort(t *testing.T) {
	var out []byte
	var mu sync.Mutex
	e := newTestEmitter(&out, &mu)

	e.Write([]byte("abc"))
	chunk := make([]byte, ringCapacity)
	e.Write(chunk) // pushes "abc" out of the ring entirely

	got := e.Since(0) // offset 0 predates everything still retained
	if len(got) != ringCapacity {
		t.Fatalf("Since(0) len = %d, want %d (best-effort full ring)", len(got), ringCapacity)
	}
	e.Close()
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

func TestEmitterZmodemDrainDropsBinaryAndKeepsPromptSuffix(t *testing.T) {
	var out []byte
	var mu sync.Mutex
	e := newTestEmitter(&out, &mu)

	e.Write([]byte("buffered protocol data"))
	e.BeginZmodemDrain()
	e.Write(make([]byte, 16*1024))
	prompt := []byte("\x1b[?2004h\x1b[01;32mroot@host\x1b[00m:# ")
	mixed := append(make([]byte, 1024), prompt...)
	e.Write(mixed)
	e.Close()

	mu.Lock()
	defer mu.Unlock()
	if string(out) != string(prompt) {
		t.Fatalf("emitted output = %q, want prompt %q", out, prompt)
	}
}

func TestEmitterZmodemDrainFindsPromptMarkerAcrossWrites(t *testing.T) {
	var out []byte
	var mu sync.Mutex
	e := newTestEmitter(&out, &mu)

	e.BeginZmodemDrain()
	e.Write([]byte{0x00, 0xff, 0x1b, 0x5b, 0x3f})
	e.Write([]byte("2004h$ "))
	e.Close()

	mu.Lock()
	defer mu.Unlock()
	want := "\x1b[?2004h$ "
	if string(out) != want {
		t.Fatalf("emitted output = %q, want %q", out, want)
	}
}
