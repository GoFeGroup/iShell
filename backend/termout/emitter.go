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
	"context"
	"encoding/base64"
	"sync"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	flushDelay = 4 * time.Millisecond // max time to accumulate after the first byte
	maxBuf     = 16 * 1024            // flush immediately once buffered bytes reach this
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
	e.buf = append(e.buf, p...)
	if len(e.buf) >= maxBuf {
		e.flushLocked()
		return
	}
	if e.timer == nil {
		e.timer = time.AfterFunc(flushDelay, e.flushTimer)
	}
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
