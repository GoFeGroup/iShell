package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// sseBody joins raw SSE "data:" JSON payloads (one per chunk) terminated by
// the standard "data: [DONE]" sentinel, mirroring how OpenAI-compatible
// servers stream chat completions.
func sseBody(chunks ...string) string {
	var b strings.Builder
	for _, c := range chunks {
		b.WriteString("data: ")
		b.WriteString(c)
		b.WriteString("\n\n")
	}
	b.WriteString("data: [DONE]\n\n")
	return b.String()
}

func contentChunk(t *testing.T, content string, finish any) string {
	t.Helper()
	payload := map[string]any{
		"choices": []any{
			map[string]any{
				"delta": map[string]any{
					"content": content,
				},
				"finish_reason": finish,
			},
		},
	}
	b, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal content chunk: %v", err)
	}
	return string(b)
}

func finishChunk(t *testing.T, finish string) string {
	t.Helper()
	payload := map[string]any{
		"choices": []any{
			map[string]any{
				"delta":         map[string]any{},
				"finish_reason": finish,
			},
		},
	}
	b, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal finish chunk: %v", err)
	}
	return string(b)
}

func TestStreamChatCompletionDeltasAndDone(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(sseBody(
			`{"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}`,
			`{"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}`,
			`{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
		)))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key", "model")
	var got strings.Builder
	var finish string
	err := c.StreamChatCompletion(context.Background(), []Message{{Role: "user", Content: "hi"}}, nil, StreamHandler{
		OnDelta: func(s string) { got.WriteString(s) },
		OnDone:  func(fr string) { finish = fr },
	})
	if err != nil {
		t.Fatalf("StreamChatCompletion: %v", err)
	}
	if got.String() != "Hello" {
		t.Fatalf("got %q, want %q", got.String(), "Hello")
	}
	if finish != "stop" {
		t.Fatalf("finish_reason = %q, want stop", finish)
	}
}

func TestStreamChatCompletionParsesDSMLToolCallContent(t *testing.T) {
	dsml := `<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="terminal_run">
<｜｜DSML｜｜parameter name="command" string="true">timeout 30 grep -i "/scale|replicas" apiserver-audit.log</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		splitAt := strings.Index(dsml, "\n") + 1
		_, _ = w.Write([]byte(sseBody(
			contentChunk(t, dsml[:splitAt], nil),
			contentChunk(t, dsml[splitAt:], nil),
			finishChunk(t, "stop"),
		)))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key", "model")
	var gotDelta strings.Builder
	var calls []ToolCall
	var finish string
	err := c.StreamChatCompletion(context.Background(), nil, AgentTools(), StreamHandler{
		OnDelta:    func(s string) { gotDelta.WriteString(s) },
		OnToolCall: func(tc []ToolCall) { calls = tc },
		OnDone:     func(fr string) { finish = fr },
	})
	if err != nil {
		t.Fatalf("StreamChatCompletion: %v", err)
	}
	if gotDelta.String() != "" {
		t.Fatalf("delta leaked DSML content: %q", gotDelta.String())
	}
	if finish != "tool_calls" {
		t.Fatalf("finish_reason = %q, want tool_calls", finish)
	}
	if len(calls) != 1 {
		t.Fatalf("got %d tool calls, want 1", len(calls))
	}
	if calls[0].ID != "dsml_call_1" || calls[0].Function.Name != "terminal_run" {
		t.Fatalf("call = %+v, want dsml terminal_run", calls[0])
	}
	var args struct {
		Command string `json:"command"`
	}
	if err := json.Unmarshal([]byte(calls[0].Function.Arguments), &args); err != nil {
		t.Fatalf("unmarshal arguments: %v", err)
	}
	want := `timeout 30 grep -i "/scale|replicas" apiserver-audit.log`
	if args.Command != want {
		t.Fatalf("command = %q, want %q", args.Command, want)
	}
}

func TestStreamChatCompletionReassemblesToolCallFragments(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(sseBody(
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"terminal_run","arguments":""}}]},"finish_reason":null}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"command\":"}}]},"finish_reason":null}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"ls\"}"}}]},"finish_reason":null}]}`,
			`{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
		)))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key", "model")
	var calls []ToolCall
	err := c.StreamChatCompletion(context.Background(), nil, AgentTools(), StreamHandler{
		OnToolCall: func(tc []ToolCall) { calls = tc },
	})
	if err != nil {
		t.Fatalf("StreamChatCompletion: %v", err)
	}
	if len(calls) != 1 {
		t.Fatalf("got %d tool calls, want 1", len(calls))
	}
	if calls[0].ID != "call_1" || calls[0].Function.Name != "terminal_run" {
		t.Fatalf("call = %+v, want id=call_1 name=terminal_run", calls[0])
	}
	if calls[0].Function.Arguments != `{"command":"ls"}` {
		t.Fatalf("arguments = %q, want %q", calls[0].Function.Arguments, `{"command":"ls"}`)
	}
}

func TestGenerateCommandSuggestionExtractsDSMLTerminalRunCommand(t *testing.T) {
	dsml := `<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="terminal_run">
<｜｜DSML｜｜parameter name="command" string="true">git subtree pull --prefix vendor/foo origin main</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(sseBody(
			contentChunk(t, dsml, nil),
			finishChunk(t, "stop"),
		)))
	}))
	defer srv.Close()

	cmd, err := NewClient(srv.URL, "key", "model").GenerateCommandSuggestion(context.Background(), "pull subtree", "")
	if err != nil {
		t.Fatalf("GenerateCommandSuggestion: %v", err)
	}
	want := "git subtree pull --prefix vendor/foo origin main"
	if cmd != want {
		t.Fatalf("cmd = %q, want %q", cmd, want)
	}
}

func TestStreamChatCompletionNon2xxReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"invalid api key"}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "bad-key", "model")
	err := c.StreamChatCompletion(context.Background(), nil, nil, StreamHandler{})
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("err = %v, want mention of 401", err)
	}
}

func TestStreamChatCompletionSkipsMalformedChunk(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(sseBody(
			`not valid json`,
			`{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}`,
		)))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key", "model")
	var got string
	err := c.StreamChatCompletion(context.Background(), nil, nil, StreamHandler{
		OnDelta: func(s string) { got += s },
	})
	if err != nil {
		t.Fatalf("StreamChatCompletion: %v", err)
	}
	if got != "ok" {
		t.Fatalf("got %q, want %q", got, "ok")
	}
}

func TestGenerateChatTitle(t *testing.T) {
	var request chatRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(sseBody(
			`{"choices":[{"delta":{"content":"### “排查 SSH 连接失败。”\\nignored"},"finish_reason":null}]}`,
			`{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
		)))
	}))
	defer srv.Close()

	title, err := NewClient(srv.URL, "key", "model").GenerateChatTitle(context.Background(), "为什么 SSH 无法连接？")
	if err != nil {
		t.Fatalf("GenerateChatTitle: %v", err)
	}
	if title != "排查 SSH 连接失败" {
		t.Fatalf("title = %q, want %q", title, "排查 SSH 连接失败")
	}
	if len(request.Tools) != 0 {
		t.Fatalf("title request exposed %d tools, want none", len(request.Tools))
	}
	if len(request.Messages) != 2 || request.Messages[1].Content != "为什么 SSH 无法连接？" {
		t.Fatalf("messages = %+v, want system prompt and original question", request.Messages)
	}
}

func TestNormalizeChatTitleCapsLength(t *testing.T) {
	got := normalizeChatTitle(strings.Repeat("界", 100))
	if len([]rune(got)) != 80 {
		t.Fatalf("title length = %d runes, want 80", len([]rune(got)))
	}
}
