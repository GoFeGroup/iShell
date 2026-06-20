// Package ai implements a minimal OpenAI-compatible Chat Completions client
// (streaming + tool-calling) and an Agent that lets the configured model
// converse with the user and, via tool calls, interact with iShell's
// terminal sessions.
package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
)

// Tool is an OpenAI-compatible function-calling tool definition.
type Tool struct {
	Type     string       `json:"type"` // "function"
	Function ToolFunction `json:"function"`
}

type ToolFunction struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

// Message is one entry in a Chat Completions conversation.
type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content,omitempty"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

// ToolCall is a model-issued function call, reconstructed from the streamed
// fragments OpenAI-compatible APIs send (id/name on the first fragment,
// arguments accumulated across subsequent fragments for the same index).
type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"` // "function"
	Function ToolCallFunc `json:"function"`
}

type ToolCallFunc struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"` // raw JSON string per OpenAI wire format
}

type chatRequest struct {
	Model    string    `json:"model"`
	Messages []Message `json:"messages"`
	Tools    []Tool    `json:"tools,omitempty"`
	Stream   bool      `json:"stream"`
}

// Client talks to a single OpenAI-compatible Chat Completions endpoint.
type Client struct {
	httpClient *http.Client
	baseURL    string
	apiKey     string
	model      string
}

// NewClient returns a Client. baseURL should be the API root (e.g.
// "https://api.openai.com/v1"); "/chat/completions" is appended per request.
func NewClient(baseURL, apiKey, model string) *Client {
	return &Client{
		httpClient: &http.Client{}, // no blanket Timeout: streams can legitimately run long; callers bound via ctx
		baseURL:    strings.TrimRight(baseURL, "/"),
		apiKey:     apiKey,
		model:      model,
	}
}

// StreamHandler receives incremental events from a streamed completion.
type StreamHandler struct {
	OnDelta    func(content string)      // incremental assistant text
	OnToolCall func(calls []ToolCall)    // fired once per round when finish_reason="tool_calls"
	OnDone     func(finishReason string) // "stop" | "tool_calls" | "length" | etc.
}

// chatChunk is the shape of one SSE "data:" payload from a streamed
// completion. tool_calls fragments are keyed by Index and reassembled below.
type chatChunk struct {
	Choices []struct {
		Delta struct {
			Content   string `json:"content"`
			ToolCalls []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Type     string `json:"type"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
}

// StreamChatCompletion issues a streaming POST /chat/completions request and
// invokes h's callbacks as the response arrives. It returns once the stream
// ends ("data: [DONE]") or ctx is cancelled.
func (c *Client) StreamChatCompletion(ctx context.Context, messages []Message, tools []Tool, h StreamHandler) error {
	body, err := json.Marshal(chatRequest{
		Model:    c.model,
		Messages: messages,
		Tools:    tools,
		Stream:   true,
	})
	if err != nil {
		return fmt.Errorf("marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
		return fmt.Errorf("ai api error %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}

	pending := map[int]*ToolCall{}
	maxIndex := -1

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue // ignore blank lines and ": comment" lines per SSE spec
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" {
			continue
		}
		if payload == "[DONE]" {
			break
		}

		var chunk chatChunk
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			log.Printf("ai: malformed SSE chunk, skipping: %v", err)
			continue
		}
		if len(chunk.Choices) == 0 {
			continue
		}
		choice := chunk.Choices[0]

		if choice.Delta.Content != "" && h.OnDelta != nil {
			h.OnDelta(choice.Delta.Content)
		}

		for _, tc := range choice.Delta.ToolCalls {
			entry, ok := pending[tc.Index]
			if !ok {
				entry = &ToolCall{Type: "function"}
				pending[tc.Index] = entry
				if tc.Index > maxIndex {
					maxIndex = tc.Index
				}
			}
			if tc.ID != "" {
				entry.ID = tc.ID
			}
			if tc.Type != "" {
				entry.Type = tc.Type
			}
			if tc.Function.Name != "" {
				entry.Function.Name = tc.Function.Name
			}
			entry.Function.Arguments += tc.Function.Arguments
		}

		if choice.FinishReason != nil {
			if *choice.FinishReason == "tool_calls" && len(pending) > 0 && h.OnToolCall != nil {
				calls := make([]ToolCall, 0, len(pending))
				for i := 0; i <= maxIndex; i++ {
					if tc, ok := pending[i]; ok {
						calls = append(calls, *tc)
					}
				}
				h.OnToolCall(calls)
			}
			if h.OnDone != nil {
				h.OnDone(*choice.FinishReason)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read stream: %w", err)
	}
	return nil
}
