// Package termout coalesces PTY output and delivers it to the frontend as a
// single, ordered stream of events.
//
// The naive pattern of calling runtime.EventsEmit once per PTY read is fragile:
// during fast typing the echo burst (character echo + prompt redraw + cursor
// moves) produces a flood of tiny events, and the Wails event bus can drop or
// reorder them under that load — the user sees missing characters ("吞字").
// SSH compounds this by emitting from two goroutines (stdout + stderr) on the
// same event name with no ordering guarantee.
//
// Emitter fixes both: every reader goroutine writes into one Emitter whose mutex
// serialises output, and writes are coalesced into far fewer, larger events
// (one per ~flushDelay window, or sooner when maxBuf is reached). The ~4ms
// latency is below human perception, so interactive feel is preserved.
package termout

import (
	"bytes"
	"context"
	"encoding/base64"
	"sync"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	flushDelay = 4 * time.Millisecond // max time to accumulate after the first byte
	maxBuf     = 16 * 1024            // flush immediately once buffered bytes reach this

	ringCapacity = 64 * 1024 // bytes of raw output retained for AI tool-call reads
)

// emit is the sink for a flushed (base64-encoded) chunk. Overridable in tests.
type emit func(event string, data string)

// Emitter accumulates PTY output and flushes it to the frontend as ordered,
// coalesced "terminal:data:<connID>" events. It is safe for concurrent Write.
type Emitter struct {
	event string // "terminal:data:" + connID
	sink  emit

	mu     sync.Mutex
	buf    []byte
	timer  *time.Timer
	closed bool

	zmodemDrain     bool
	zmodemDrainTail []byte

	// Bounded ring buffer of raw output, independent of the coalesce/flush
	// path above — read by AI tool calls (Snapshot/Since) to see what a
	// terminal_run command produced, without affecting the frontend stream.
	ring      []byte
	ringHead  int   // next write position within ring, wraps at ringCapacity
	ringTotal int64 // monotonic count of all bytes ever written to the ring
}

// New returns an Emitter that emits "terminal:data:<connID>" events on ctx.
func New(ctx context.Context, connID string) *Emitter {
	return &Emitter{
		event: "terminal:data:" + connID,
		sink: func(event, data string) {
			wailsRuntime.EventsEmit(ctx, event, data)
		},
	}
}

var zmodemRecoveryMarkers = [][]byte{
	{0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x30, 0x34, 0x68}, // ESC[?2004h
	[]byte("\x1b]1337;CurrentDir="),
}

func zmodemRecoveryOffset(p []byte) int {
	offset := -1
	for _, marker := range zmodemRecoveryMarkers {
		if i := bytes.Index(p, marker); i >= 0 && (offset < 0 || i < offset) {
			offset = i
		}
	}
	return offset
}

// BeginZmodemDrain drops buffered and subsequent protocol output until a
// strong interactive-shell marker appears. Already-emitted frontend events
// are handled by the matching fast drain in zmodem.js.
func (e *Emitter) BeginZmodemDrain() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.timer != nil {
		e.timer.Stop()
		e.timer = nil
	}
	e.buf = e.buf[:0]
	e.zmodemDrain = true
	e.zmodemDrainTail = e.zmodemDrainTail[:0]
}

// Write appends p to the buffer and schedules a flush. It is safe to call from
// multiple reader goroutines concurrently; the mutex serialises their output so
// the frontend receives a single ordered stream. Write never blocks on I/O.
func (e *Emitter) Write(p []byte) {
	if len(p) == 0 {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return
	}
	e.writeRingLocked(p)
	if e.zmodemDrain {
		combined := make([]byte, 0, len(e.zmodemDrainTail)+len(p))
		combined = append(combined, e.zmodemDrainTail...)
		combined = append(combined, p...)
		if offset := zmodemRecoveryOffset(combined); offset >= 0 {
			e.zmodemDrain = false
			e.zmodemDrainTail = e.zmodemDrainTail[:0]
			p = combined[offset:]
		} else {
			const tailSize = 17
			if len(combined) > tailSize {
				combined = combined[len(combined)-tailSize:]
			}
			e.zmodemDrainTail = append(e.zmodemDrainTail[:0], combined...)
			return
		}
	}
	e.buf = append(e.buf, p...)
	if len(e.buf) >= maxBuf {
		e.flushLocked()
		return
	}
	if e.timer == nil {
		e.timer = time.AfterFunc(flushDelay, e.flushTimer)
	}
}

// writeRingLocked copies p into the ring buffer, wrapping as needed. Caller
// holds e.mu.
func (e *Emitter) writeRingLocked(p []byte) {
	if e.ring == nil {
		e.ring = make([]byte, ringCapacity)
	}
	n := len(p)
	if n >= ringCapacity {
		copy(e.ring, p[n-ringCapacity:])
		e.ringHead = 0
		e.ringTotal += int64(n)
		return
	}
	end := e.ringHead + n
	if end <= ringCapacity {
		copy(e.ring[e.ringHead:end], p)
		e.ringHead = end % ringCapacity
	} else {
		firstPart := ringCapacity - e.ringHead
		copy(e.ring[e.ringHead:], p[:firstPart])
		copy(e.ring[:n-firstPart], p[firstPart:])
		e.ringHead = n - firstPart
	}
	e.ringTotal += int64(n)
}

// Snapshot returns the current ring buffer contents (oldest-to-newest, up to
// ringCapacity bytes) and the monotonic offset just past the last byte
// returned. Pass that offset to Since() later to fetch only what arrived
// after this snapshot.
func (e *Emitter) Snapshot() ([]byte, int64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.snapshotLocked(), e.ringTotal
}

func (e *Emitter) snapshotLocked() []byte {
	if e.ringTotal == 0 {
		return nil
	}
	size := min(e.ringTotal, int64(ringCapacity))
	out := make([]byte, size)
	if e.ringTotal <= int64(ringCapacity) {
		copy(out, e.ring[:size])
		return out
	}
	copy(out, e.ring[e.ringHead:])
	copy(out[ringCapacity-e.ringHead:], e.ring[:e.ringHead])
	return out
}

// Since returns bytes written after the given offset. It is best-effort: if
// offset is older than what the ring buffer still holds, it returns the
// oldest data still available rather than erroring.
func (e *Emitter) Since(offset int64) []byte {
	e.mu.Lock()
	defer e.mu.Unlock()
	full := e.snapshotLocked()
	if len(full) == 0 {
		return nil
	}
	oldestOffset := e.ringTotal - int64(len(full))
	if offset <= oldestOffset {
		return full
	}
	if offset >= e.ringTotal {
		return nil
	}
	return full[offset-oldestOffset:]
}

// Close flushes any remaining buffered bytes and stops the Emitter. Call it
// before emitting "terminal:closed" so the tail of the output is not lost.
func (e *Emitter) Close() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.closed = true
	if e.timer != nil {
		e.timer.Stop()
		e.timer = nil
	}
	if len(e.buf) > 0 {
		e.flushLocked()
	}
}

// flushTimer is the time.AfterFunc callback; it acquires the lock and flushes.
func (e *Emitter) flushTimer() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.timer = nil
	if e.closed || len(e.buf) == 0 {
		return
	}
	e.flushLocked()
}

// flushLocked encodes and emits the buffer, then clears it. Caller holds e.mu.
func (e *Emitter) flushLocked() {
	if e.timer != nil {
		e.timer.Stop()
		e.timer = nil
	}
	encoded := base64.StdEncoding.EncodeToString(e.buf)
	e.buf = e.buf[:0]
	e.sink(e.event, encoded)
}
