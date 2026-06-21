package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"ishell/backend/storage"
)

// fakeTerminalIO is a minimal TerminalIO double recording sent input.
// Snapshot/Since return canned data — round-trip offset semantics are
// exercised separately by backend/termout's own tests.
type fakeTerminalIO struct {
	mu   sync.Mutex
	sent []string
}

func (f *fakeTerminalIO) SendInput(_ string, data string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, data)
	return nil
}

func (f *fakeTerminalIO) Snapshot(_ string) ([]byte, int64, error) {
	return nil, 0, nil
}

func (f *fakeTerminalIO) Since(_ string, _ int64) ([]byte, error) {
	return []byte("total 0\n"), nil
}

func (f *fakeTerminalIO) sentCommands() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.sent...)
}

func newTestStore(t *testing.T) *storage.Store {
	t.Helper()
	st, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func enableAI(t *testing.T, st *storage.Store, baseURL string) {
	t.Helper()
	settings, err := st.LoadSettings()
	if err != nil {
		t.Fatalf("load settings: %v", err)
	}
	settings.AIEnabled = true
	settings.AIAPIKey = "test-key"
	settings.AIBaseURL = baseURL
	settings.AIModel = "test-model"
	if err := st.SaveSettings(*settings); err != nil {
		t.Fatalf("save settings: %v", err)
	}
}

type recordedEvent struct {
	name    string
	payload any
}

// eventRecorder is a fake emit sink that both keeps full history (for
// synchronous RunTurn calls) and supports blocking waits (for the
// goroutine-based approval-pause tests).
type eventRecorder struct {
	mu     sync.Mutex
	events []recordedEvent
	subs   map[string][]chan any
}

func newEventRecorder() *eventRecorder {
	return &eventRecorder{subs: make(map[string][]chan any)}
}

func (r *eventRecorder) emit(event string, payload any) {
	r.mu.Lock()
	r.events = append(r.events, recordedEvent{event, payload})
	chans := append([]chan any{}, r.subs[event]...)
	r.mu.Unlock()
	for _, ch := range chans {
		ch <- payload
	}
}

func (r *eventRecorder) has(event string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, e := range r.events {
		if e.name == event {
			return true
		}
	}
	return false
}

// waitFor returns the payload of the first occurrence of event, checking
// history first so it works whether the event already happened (synchronous
// RunTurn calls) or hasn't yet (RunTurn running in its own goroutine).
func (r *eventRecorder) waitFor(t *testing.T, event string, timeout time.Duration) any {
	t.Helper()
	r.mu.Lock()
	for _, e := range r.events {
		if e.name == event {
			r.mu.Unlock()
			return e.payload
		}
	}
	ch := make(chan any, 1)
	r.subs[event] = append(r.subs[event], ch)
	r.mu.Unlock()
	select {
	case payload := <-ch:
		return payload
	case <-time.After(timeout):
		t.Fatalf("timed out waiting for event %q", event)
		return nil
	}
}

// requestHasToolResult decodes the streamed request body's messages and
// reports whether a "tool" role reply is already present, letting test
// servers distinguish the first round (propose a tool call) from the
// follow-up round (model sees the tool's output).
func requestHasToolResult(r *http.Request) bool {
	var req struct {
		Messages []struct {
			Role string `json:"role"`
		} `json:"messages"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	for _, m := range req.Messages {
		if m.Role == "tool" {
			return true
		}
	}
	return false
}

func requestHasTools(r *http.Request) bool {
	var req struct {
		Tools []Tool `json:"tools"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	return len(req.Tools) > 0
}

func TestRunTurnPlainReplyNoTools(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(sseBody(
			`{"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}`,
			`{"choices":[{"delta":{"content":" there"},"finish_reason":null}]}`,
			`{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
		)))
	}))
	defer srv.Close()

	st := newTestStore(t)
	enableAI(t, st, srv.URL)
	sess, err := st.SaveAIChatSession(storage.AIChatSession{Title: "Test"})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	rec := newEventRecorder()
	ag := NewAgent(st, &fakeTerminalIO{}, rec.emit)
	ag.RunTurn(context.Background(), RunOptions{ChatID: sess.ID, UserText: "hi"})

	done := rec.waitFor(t, "ai:done:"+sess.ID, 2*time.Second).(map[string]string)
	if done["finish_reason"] != "stop" {
		t.Fatalf("finish_reason = %q, want stop", done["finish_reason"])
	}

	msgs, err := st.ListAIChatMessages(sess.ID)
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	var assistant string
	for _, m := range msgs {
		if m.Role == "assistant" {
			assistant = m.Content
		}
	}
	if assistant != "Hello there" {
		t.Fatalf("assistant content = %q, want %q", assistant, "Hello there")
	}
}

func TestRunTurnToolCallRequiresApproval(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		if !requestHasToolResult(r) {
			_, _ = w.Write([]byte(sseBody(
				`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"terminal_run","arguments":""}}]},"finish_reason":null}]}`,
				`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"command\":\"ls\"}"}}]},"finish_reason":null}]}`,
				`{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
			)))
			return
		}
		_, _ = w.Write([]byte(sseBody(
			`{"choices":[{"delta":{"content":"Done."},"finish_reason":null}]}`,
			`{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
		)))
	}))
	defer srv.Close()

	st := newTestStore(t)
	enableAI(t, st, srv.URL)
	sess, err := st.SaveAIChatSession(storage.AIChatSession{Title: "Test"})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	term := &fakeTerminalIO{}
	rec := newEventRecorder()
	ag := NewAgent(st, term, rec.emit)

	runDone := make(chan struct{})
	go func() {
		ag.RunTurn(context.Background(), RunOptions{ChatID: sess.ID, ConnID: "conn-1", UserText: "list files"})
		close(runDone)
	}()

	toolCall := rec.waitFor(t, "ai:tool_call:"+sess.ID, 2*time.Second).(map[string]string)
	if toolCall["command"] != "ls" {
		t.Fatalf("command = %q, want %q", toolCall["command"], "ls")
	}
	if len(term.sentCommands()) != 0 {
		t.Fatal("command must not be sent before approval")
	}

	if err := ag.ApproveToolCall(toolCall["pending_id"]); err != nil {
		t.Fatalf("approve: %v", err)
	}

	select {
	case <-runDone:
	case <-time.After(2 * time.Second):
		t.Fatal("RunTurn did not finish after approval")
	}

	sent := term.sentCommands()
	if len(sent) != 1 || sent[0] != "ls\n" {
		t.Fatalf("sent = %v, want [%q]", sent, "ls\n")
	}
	rec.waitFor(t, "ai:done:"+sess.ID, time.Second)
}

func TestRunTurnRejectToolCallSkipsExecution(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		if !requestHasToolResult(r) {
			_, _ = w.Write([]byte(sseBody(
				`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"terminal_run","arguments":"{\"command\":\"rm -rf /\"}"}}]},"finish_reason":null}]}`,
				`{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
			)))
			return
		}
		_, _ = w.Write([]byte(sseBody(
			`{"choices":[{"delta":{"content":"Understood."},"finish_reason":null}]}`,
			`{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
		)))
	}))
	defer srv.Close()

	st := newTestStore(t)
	enableAI(t, st, srv.URL)
	sess, err := st.SaveAIChatSession(storage.AIChatSession{Title: "Reject"})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	term := &fakeTerminalIO{}
	rec := newEventRecorder()
	ag := NewAgent(st, term, rec.emit)

	runDone := make(chan struct{})
	go func() {
		ag.RunTurn(context.Background(), RunOptions{ChatID: sess.ID, ConnID: "conn-1", UserText: "wipe everything"})
		close(runDone)
	}()

	toolCall := rec.waitFor(t, "ai:tool_call:"+sess.ID, 2*time.Second).(map[string]string)
	if err := ag.RejectToolCall(toolCall["pending_id"]); err != nil {
		t.Fatalf("reject: %v", err)
	}

	select {
	case <-runDone:
	case <-time.After(2 * time.Second):
		t.Fatal("RunTurn did not finish after rejection")
	}

	if len(term.sentCommands()) != 0 {
		t.Fatal("rejected command must never be sent to the terminal")
	}
	rec.waitFor(t, "ai:tool_rejected:"+sess.ID, time.Second)
}

func TestRunTurnAutoExecSkipsApprovalCard(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		if !requestHasToolResult(r) {
			_, _ = w.Write([]byte(sseBody(
				`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"terminal_run","arguments":"{\"command\":\"pwd\"}"}}]},"finish_reason":null}]}`,
				`{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
			)))
			return
		}
		_, _ = w.Write([]byte(sseBody(
			`{"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}`,
			`{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
		)))
	}))
	defer srv.Close()

	st := newTestStore(t)
	enableAI(t, st, srv.URL)
	sess, err := st.SaveAIChatSession(storage.AIChatSession{Title: "Auto", AutoExec: true})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	term := &fakeTerminalIO{}
	rec := newEventRecorder()
	ag := NewAgent(st, term, rec.emit)

	ag.RunTurn(context.Background(), RunOptions{ChatID: sess.ID, ConnID: "conn-1", UserText: "pwd please"})

	rec.waitFor(t, "ai:done:"+sess.ID, 2*time.Second)
	if rec.has("ai:tool_call:" + sess.ID) {
		t.Fatal("auto-exec session should never emit an approval card")
	}
	sent := term.sentCommands()
	if len(sent) != 1 || sent[0] != "pwd\n" {
		t.Fatalf("sent = %v, want [%q]", sent, "pwd\n")
	}
}

func TestRunTurnWebSearchTool(t *testing.T) {
	searchSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("q"); got != "golang release" {
			t.Fatalf("search query = %q, want %q", got, "golang release")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"Heading":"Go",
			"AbstractText":"Go is an open source programming language.",
			"AbstractURL":"https://go.dev/",
			"RelatedTopics":[{"Text":"Go releases - Release history","FirstURL":"https://go.dev/doc/devel/release"}]
		}`))
	}))
	defer searchSrv.Close()

	aiSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		if !requestHasToolResult(r) {
			_, _ = w.Write([]byte(sseBody(
				`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_search","type":"function","function":{"name":"websearch","arguments":"{\"query\":\"golang release\"}"}}]},"finish_reason":null}]}`,
				`{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
			)))
			return
		}
		_, _ = w.Write([]byte(sseBody(
			`{"choices":[{"delta":{"content":"Found it."},"finish_reason":null}]}`,
			`{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
		)))
	}))
	defer aiSrv.Close()

	st := newTestStore(t)
	enableAI(t, st, aiSrv.URL)
	settings, err := st.LoadSettings()
	if err != nil {
		t.Fatalf("load settings: %v", err)
	}
	settings.AIWebSearchEngine = "duckduckgo"
	settings.AIWebSearchEndpoint = searchSrv.URL
	if err := st.SaveSettings(*settings); err != nil {
		t.Fatalf("save settings: %v", err)
	}
	sess, err := st.SaveAIChatSession(storage.AIChatSession{Title: "Search"})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	rec := newEventRecorder()
	ag := NewAgent(st, &fakeTerminalIO{}, rec.emit)
	ag.RunTurn(context.Background(), RunOptions{ChatID: sess.ID, UserText: "search latest Go release"})

	result := rec.waitFor(t, "ai:tool_result:"+sess.ID, 2*time.Second).(map[string]any)
	if result["tool"] != "websearch" {
		t.Fatalf("tool = %v, want websearch", result["tool"])
	}
	if result["command"] != "golang release" {
		t.Fatalf("command = %v, want golang release", result["command"])
	}
	output, _ := result["output"].(string)
	if !strings.Contains(output, "Go is an open source programming language.") {
		t.Fatalf("output = %q, want search summary", output)
	}
	rec.waitFor(t, "ai:done:"+sess.ID, time.Second)
}

func TestRunTurnRepeatedToolLoopFinishesWithGuardedAnswer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		if !requestHasTools(r) {
			_, _ = w.Write([]byte(sseBody(
				`{"choices":[{"delta":{"content":"I already checked the terminal and there is no new output to report."},"finish_reason":null}]}`,
				`{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
			)))
			return
		}
		_, _ = w.Write([]byte(sseBody(
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"terminal_read","arguments":"{}"}}]},"finish_reason":null}]}`,
			`{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
		)))
	}))
	defer srv.Close()

	st := newTestStore(t)
	enableAI(t, st, srv.URL)
	sess, err := st.SaveAIChatSession(storage.AIChatSession{Title: "Loop"})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	rec := newEventRecorder()
	ag := NewAgent(st, &fakeTerminalIO{}, rec.emit)
	ag.RunTurn(context.Background(), RunOptions{ChatID: sess.ID, ConnID: "conn-1", UserText: "loop forever"})

	done := rec.waitFor(t, "ai:done:"+sess.ID, 5*time.Second).(map[string]string)
	if !strings.Contains(done["guard_reason"], "without making progress") {
		t.Fatalf("guard_reason = %q, want progress-loop explanation", done["guard_reason"])
	}
	if rec.has("ai:error:" + sess.ID) {
		t.Fatal("repeated tool loop should finish with a guarded answer, not emit an error")
	}

	msgs, err := st.ListAIChatMessages(sess.ID)
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	gotFinal := ""
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == "assistant" && msgs[i].Content != "" {
			gotFinal = msgs[i].Content
			break
		}
	}
	if !strings.Contains(gotFinal, "no new output") {
		t.Fatalf("final assistant content = %q, want guarded final answer", gotFinal)
	}
}

func TestRunTurnRejectsWhenAIDisabled(t *testing.T) {
	st := newTestStore(t)
	sess, err := st.SaveAIChatSession(storage.AIChatSession{Title: "Disabled"})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	rec := newEventRecorder()
	ag := NewAgent(st, &fakeTerminalIO{}, rec.emit)
	ag.RunTurn(context.Background(), RunOptions{ChatID: sess.ID, UserText: "hi"})

	got := rec.waitFor(t, "ai:error:"+sess.ID, time.Second).(map[string]string)
	if !strings.Contains(got["message"], "not enabled") {
		t.Fatalf("error message = %q, want mention of AI being disabled", got["message"])
	}
}
