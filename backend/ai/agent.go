package ai

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"ishell/backend/storage"
)

const (
	maxToolRounds    = 8                      // tool_calls→execute→feed-back cycles per user message, before giving up
	commandWaitDelay = 800 * time.Millisecond // time to let a sent command produce output before reading it back
	approvalTimeout  = 10 * time.Minute       // how long a pending command waits for human approval before auto-rejecting
)

const (
	maxConsecutiveStagnantRounds  = 2
	maxConsecutiveToolErrorRounds = 2
)

// placeholderPattern matches {{name}} command template placeholders.
var placeholderPattern = regexp.MustCompile(`\{\{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\}\}`)

const systemPrompt = `You are an AI assistant embedded in the iShell terminal application. You can chat with the user, call websearch for current or external information, and when a terminal tab is active you may call the terminal_run and terminal_read tools to interact with it directly: terminal_run sends a command (followed by Enter) to the terminal and returns the output produced shortly after; terminal_read checks the terminal's most recent output without sending anything, which is useful for checking on a long-running command. Only call the terminal tools when the user's request requires interacting with their terminal. If no terminal tab is active and the user asks you to run something, tell them to open a terminal tab first instead of calling the terminal tools. Additional tools beyond the ones described here may also be available for this conversation — consult each tool's own description to learn what it does and when to use it.`

// TerminalIO abstracts the local/ssh manager dispatch that *backend.App
// already performs for SendInput, so this package never imports
// backend/ssh or backend/local directly.
type TerminalIO interface {
	SendInput(connID, data string) error
	Snapshot(connID string) (data []byte, offset int64, err error)
	Since(connID string, offset int64) ([]byte, error)
}

// RunOptions describes one user turn to drive through the agent loop.
type RunOptions struct {
	ChatID   string // AI chat session ID
	ConnID   string // currently active terminal tab, resolved by the frontend; "" if none
	UserText string
}

// PendingApproval is a terminal_run call awaiting the user's Run/Reject
// decision from the chat UI.
type PendingApproval struct {
	ID         string
	ChatID     string
	ToolCallID string
	Command    string
	resultCh   chan approvalResult
}

type approvalResult struct {
	approved bool
}

// Agent orchestrates chat turns: it builds conversation history from
// storage, drives the streaming completion, executes/pauses-for-approval
// terminal tool calls, and persists + emits events for everything along the
// way. One Agent serves all chat sessions; per-session state (pending
// approvals, in-flight runs) is tracked in maps keyed by ID.
type Agent struct {
	store  *storage.Store
	termIO TerminalIO
	emit   func(event string, payload any)

	mu      sync.Mutex
	pending map[string]*PendingApproval
	running map[string]context.CancelFunc
}

func NewAgent(store *storage.Store, termIO TerminalIO, emit func(event string, payload any)) *Agent {
	return &Agent{
		store:   store,
		termIO:  termIO,
		emit:    emit,
		pending: make(map[string]*PendingApproval),
		running: make(map[string]context.CancelFunc),
	}
}

// RunTurn drives one user message through to completion: persists it,
// streams the model's reply across however many tool-calling rounds it
// takes, and returns once the model gives a final plain-text answer, the
// round limit is hit, or an error occurs. Intended to be run in its own
// goroutine; all output arrives via the emit callback (ai:* events).
func (ag *Agent) RunTurn(ctx context.Context, opts RunOptions) {
	runCtx, cancel := context.WithCancel(ctx)
	ag.mu.Lock()
	if _, exists := ag.running[opts.ChatID]; exists {
		ag.mu.Unlock()
		cancel()
		ag.emitError(opts.ChatID, fmt.Errorf("a generation is already running for this chat"))
		return
	}
	ag.running[opts.ChatID] = cancel
	ag.mu.Unlock()
	defer func() {
		ag.mu.Lock()
		delete(ag.running, opts.ChatID)
		ag.mu.Unlock()
		cancel()
	}()

	settings, client, err := ag.loadSettingsAndClient()
	if err != nil {
		ag.emitError(opts.ChatID, err)
		return
	}
	customTools := settings.CustomToolCalls

	if _, err := ag.store.AppendAIChatMessage(storage.AIChatMessage{
		SessionID: opts.ChatID, Role: "user", Content: opts.UserText,
	}); err != nil {
		ag.emitError(opts.ChatID, err)
		return
	}

	guard := newToolLoopGuard()
	for range maxToolRounds {
		history, err := ag.buildHistory(opts.ChatID)
		if err != nil {
			ag.emitError(opts.ChatID, err)
			return
		}

		assistantMsg, finishReason, err := ag.runRound(runCtx, client, opts, history, customTools)
		if err != nil {
			ag.emitError(opts.ChatID, err)
			return
		}

		toolCallsJSON := ""
		if len(assistantMsg.ToolCalls) > 0 {
			if b, err := json.Marshal(assistantMsg.ToolCalls); err == nil {
				toolCallsJSON = string(b)
			}
		}
		if _, err := ag.store.AppendAIChatMessage(storage.AIChatMessage{
			SessionID: opts.ChatID, Role: "assistant", Content: assistantMsg.Content, ToolCalls: toolCallsJSON,
		}); err != nil {
			ag.emitError(opts.ChatID, err)
			return
		}

		if finishReason != "tool_calls" || len(assistantMsg.ToolCalls) == 0 {
			ag.emit("ai:done:"+opts.ChatID, map[string]string{"finish_reason": finishReason})
			return
		}

		sess, _ := ag.store.GetAIChatSession(opts.ChatID)
		autoExec := sess != nil && sess.AutoExec

		results := make([]toolCallResult, 0, len(assistantMsg.ToolCalls))
		for _, call := range assistantMsg.ToolCalls {
			result := ag.handleToolCall(runCtx, opts, call, autoExec, customTools)
			if _, err := ag.store.AppendAIChatMessage(storage.AIChatMessage{
				SessionID: opts.ChatID, Role: "tool", Content: result, ToolCallID: call.ID,
			}); err != nil {
				ag.emitError(opts.ChatID, err)
				return
			}
			results = append(results, toolCallResult{call: call, output: result})
		}
		if reason, stuck := guard.observe(results); stuck {
			ag.finishAfterToolGuard(runCtx, client, opts, reason)
			return
		}
		// Loop continues: the tool results just persisted become part of the
		// history fed into the next round's request.
	}

	ag.finishAfterToolGuard(runCtx, client, opts, "the tool loop reached the safety limit before producing a final answer")
}

// ApproveToolCall lets a previously emitted "ai:tool_call" proceed.
func (ag *Agent) ApproveToolCall(pendingID string) error {
	return ag.resolveToolCall(pendingID, true)
}

// RejectToolCall declines a previously emitted "ai:tool_call"; the agent
// feeds a rejection message back to the model instead of running it.
func (ag *Agent) RejectToolCall(pendingID string) error {
	return ag.resolveToolCall(pendingID, false)
}

func (ag *Agent) resolveToolCall(pendingID string, approved bool) error {
	ag.mu.Lock()
	p, ok := ag.pending[pendingID]
	ag.mu.Unlock()
	if !ok {
		return fmt.Errorf("no pending approval %s", pendingID)
	}
	select {
	case p.resultCh <- approvalResult{approved: approved}:
		return nil
	default:
		return fmt.Errorf("approval %s was already resolved", pendingID)
	}
}

// SetAutoExec flips a chat session's persisted auto-execute flag.
func (ag *Agent) SetAutoExec(chatID string, on bool) error {
	return ag.store.SetAIChatAutoExec(chatID, on)
}

// StopRun cancels an in-flight RunTurn for chatID, if any.
func (ag *Agent) StopRun(chatID string) {
	ag.mu.Lock()
	cancel, ok := ag.running[chatID]
	ag.mu.Unlock()
	if ok {
		cancel()
	}
}

// ── internals ────────────────────────────────────────────────────────────────

func (ag *Agent) loadSettingsAndClient() (*storage.Settings, *Client, error) {
	settings, err := ag.store.LoadSettings()
	if err != nil {
		return nil, nil, fmt.Errorf("load settings: %w", err)
	}
	if !settings.AIEnabled {
		return nil, nil, fmt.Errorf("AI is not enabled in settings")
	}
	if settings.AIAPIKey == "" || settings.AIBaseURL == "" || settings.AIModel == "" {
		return nil, nil, fmt.Errorf("AI provider is not fully configured (key/base URL/model)")
	}
	return settings, NewClient(settings.AIBaseURL, settings.AIAPIKey, settings.AIModel), nil
}

func (ag *Agent) buildHistory(chatID string) ([]Message, error) {
	stored, err := ag.store.ListAIChatMessages(chatID)
	if err != nil {
		return nil, err
	}
	messages := make([]Message, 0, len(stored)+1)
	messages = append(messages, Message{Role: "system", Content: systemPrompt})
	for _, m := range stored {
		msg := Message{Role: m.Role, Content: m.Content, ToolCallID: m.ToolCallID}
		if m.ToolCalls != "" {
			var calls []ToolCall
			if err := json.Unmarshal([]byte(m.ToolCalls), &calls); err == nil {
				msg.ToolCalls = calls
			}
		}
		messages = append(messages, msg)
	}
	return messages, nil
}

func (ag *Agent) runRound(ctx context.Context, client *Client, opts RunOptions, history []Message, customTools []storage.CustomToolCall) (Message, string, error) {
	return ag.runRoundWithTools(ctx, client, opts, history, BuildToolList(customTools))
}

func (ag *Agent) runRoundWithTools(ctx context.Context, client *Client, opts RunOptions, history []Message, tools []Tool) (Message, string, error) {
	var content strings.Builder
	var toolCalls []ToolCall
	var finishReason string

	err := client.StreamChatCompletion(ctx, history, tools, StreamHandler{
		OnDelta: func(delta string) {
			content.WriteString(delta)
			ag.emit("ai:delta:"+opts.ChatID, map[string]string{"content": delta})
		},
		OnToolCall: func(calls []ToolCall) {
			toolCalls = calls
		},
		OnDone: func(fr string) {
			finishReason = fr
		},
	})
	if err != nil {
		return Message{}, "", err
	}
	return Message{Role: "assistant", Content: content.String(), ToolCalls: toolCalls}, finishReason, nil
}

func (ag *Agent) finishAfterToolGuard(ctx context.Context, client *Client, opts RunOptions, reason string) {
	history, err := ag.buildHistory(opts.ChatID)
	if err != nil {
		ag.emitError(opts.ChatID, err)
		return
	}
	history = append(history, Message{
		Role: "system",
		Content: "The tool loop guard stopped further tool execution because " + reason +
			". Do not call tools again. Give the user the best final answer you can from the conversation and tool results already available. If the task cannot be completed, explain what is missing and the next concrete step.",
	})

	assistantMsg, finishReason, err := ag.runRoundWithTools(ctx, client, opts, history, nil)
	if err != nil {
		ag.emitError(opts.ChatID, fmt.Errorf("tool loop stopped because %s; final response failed: %w", reason, err))
		return
	}
	if strings.TrimSpace(assistantMsg.Content) == "" {
		assistantMsg.Content = "I stopped using tools because " + reason + ". I do not have enough new information to continue safely."
		ag.emit("ai:delta:"+opts.ChatID, map[string]string{"content": assistantMsg.Content})
	}
	if finishReason == "tool_calls" {
		finishReason = "guarded_stop"
	}
	if _, err := ag.store.AppendAIChatMessage(storage.AIChatMessage{
		SessionID: opts.ChatID, Role: "assistant", Content: assistantMsg.Content,
	}); err != nil {
		ag.emitError(opts.ChatID, err)
		return
	}
	ag.emit("ai:done:"+opts.ChatID, map[string]string{"finish_reason": finishReason, "guard_reason": reason})
}

// handleToolCall executes (or pauses for approval, then executes) a single
// tool call and returns the text to feed back to the model as the "tool"
// role reply. It never returns an error directly — failures are encoded as
// "error: ..." text so the model can react instead of aborting the turn.
func (ag *Agent) handleToolCall(ctx context.Context, opts RunOptions, call ToolCall, autoExec bool, customTools []storage.CustomToolCall) string {
	switch call.Function.Name {
	case "websearch":
		// Web searches are read-only network requests from local settings, so
		// they intentionally bypass the terminal command approval flow.
		return ag.handleWebSearch(ctx, opts, call)
	case "terminal_read":
		if opts.ConnID == "" {
			return "error: no active terminal tab to read from"
		}
		output, err := ag.captureOutput(opts.ConnID, 0)
		if err != nil {
			return fmt.Sprintf("error: %v", err)
		}
		ag.emit("ai:tool_result:"+opts.ChatID, map[string]any{
			"tool_call_id": call.ID, "tool": call.Function.Name, "command": "", "output": output, "auto": true,
		})
		return output
	case "terminal_run":
		return ag.handleTerminalRun(ctx, opts, call, autoExec)
	default:
		for _, def := range customTools {
			if def.Enabled && def.Name == call.Function.Name {
				return ag.handleCustomToolCall(ctx, opts, call, def, autoExec)
			}
		}
		return fmt.Sprintf("error: unknown tool %q", call.Function.Name)
	}
}

func (ag *Agent) handleTerminalRun(ctx context.Context, opts RunOptions, call ToolCall, autoExec bool) string {
	var args struct {
		Command string `json:"command"`
	}
	_ = json.Unmarshal([]byte(call.Function.Arguments), &args)

	if opts.ConnID == "" {
		return "error: no active terminal tab to run commands in"
	}
	return ag.runApprovableCommand(ctx, opts, call, args.Command, autoExec)
}

// handleCustomToolCall renders a user-defined command template with the
// model-supplied arguments and runs it through the same approval/auto-exec
// flow as terminal_run.
func (ag *Agent) handleCustomToolCall(ctx context.Context, opts RunOptions, call ToolCall, def storage.CustomToolCall, autoExec bool) string {
	// Arguments are decoded into map[string]any rather than map[string]string
	// because some models send numeric/boolean argument values; unmarshaling
	// those into a string map fails outright and silently drops every
	// parameter instead of just the offending one.
	var rawArgs map[string]any
	_ = json.Unmarshal([]byte(call.Function.Arguments), &rawArgs)
	args := make(map[string]string, len(rawArgs))
	for k, v := range rawArgs {
		args[k] = fmt.Sprintf("%v", v)
	}

	for _, p := range def.Parameters {
		if p.Required {
			if v, ok := args[p.Name]; !ok || v == "" {
				return fmt.Sprintf("error: missing required parameter %q", p.Name)
			}
		}
	}

	if opts.ConnID == "" {
		return "error: no active terminal tab to run commands in"
	}

	command := renderCommandTemplate(def.CommandTemplate, args)
	return ag.runApprovableCommand(ctx, opts, call, command, autoExec)
}

// renderCommandTemplate substitutes {{name}} placeholders with their string
// value from args, then strips any placeholder that had no matching
// argument (e.g. an optional parameter the model chose not to supply) so a
// literal "{{x}}" never reaches the terminal.
func renderCommandTemplate(template string, args map[string]string) string {
	rendered := placeholderPattern.ReplaceAllStringFunc(template, func(match string) string {
		name := strings.TrimSpace(match[2 : len(match)-2])
		if v, ok := args[name]; ok {
			return v
		}
		return match
	})
	return placeholderPattern.ReplaceAllString(rendered, "")
}

// runApprovableCommand is shared by terminal_run and every custom tool call:
// it either runs the command immediately (auto-exec) or emits an approval
// card and waits for the user's Run/Reject decision (or a timeout/cancel).
func (ag *Agent) runApprovableCommand(ctx context.Context, opts RunOptions, call ToolCall, command string, autoExec bool) string {
	if autoExec {
		return ag.runCommand(ctx, opts, call, command, true)
	}

	pending := &PendingApproval{
		ID:         uuid.NewString(),
		ChatID:     opts.ChatID,
		ToolCallID: call.ID,
		Command:    command,
		resultCh:   make(chan approvalResult, 1),
	}
	ag.mu.Lock()
	ag.pending[pending.ID] = pending
	ag.mu.Unlock()
	defer func() {
		ag.mu.Lock()
		delete(ag.pending, pending.ID)
		ag.mu.Unlock()
	}()

	ag.emit("ai:tool_call:"+opts.ChatID, map[string]string{
		"pending_id": pending.ID, "tool_call_id": call.ID, "command": command,
	})

	select {
	case res := <-pending.resultCh:
		if !res.approved {
			ag.emit("ai:tool_rejected:"+opts.ChatID, map[string]string{
				"pending_id": pending.ID, "tool_call_id": call.ID,
			})
			return "User declined to run this command."
		}
		return ag.runCommand(ctx, opts, call, command, false)
	case <-time.After(approvalTimeout):
		return "User did not respond to the approval request in time; the command was not run."
	case <-ctx.Done():
		return "Run was cancelled before the command was approved."
	}
}

func (ag *Agent) runCommand(ctx context.Context, opts RunOptions, call ToolCall, command string, auto bool) string {
	_, offsetBefore, err := ag.termIO.Snapshot(opts.ConnID)
	if err != nil {
		return fmt.Sprintf("error: %v", err)
	}
	if err := ag.termIO.SendInput(opts.ConnID, command+"\n"); err != nil {
		return fmt.Sprintf("error: %v", err)
	}

	select {
	case <-time.After(commandWaitDelay):
	case <-ctx.Done():
	}

	output, err := ag.captureOutput(opts.ConnID, offsetBefore)
	if err != nil {
		output = fmt.Sprintf("error reading output: %v", err)
	}
	ag.emit("ai:tool_result:"+opts.ChatID, map[string]any{
		"tool_call_id": call.ID, "tool": call.Function.Name, "command": command, "output": output, "auto": auto,
	})
	return output
}

func (ag *Agent) captureOutput(connID string, sinceOffset int64) (string, error) {
	data, err := ag.termIO.Since(connID, sinceOffset)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func (ag *Agent) emitError(chatID string, err error) {
	ag.emit("ai:error:"+chatID, map[string]string{"message": err.Error()})
}

type toolCallResult struct {
	call   ToolCall
	output string
}

type toolLoopGuard struct {
	lastSignature string
	lastResultKey string
	stagnant      int
	errorRounds   int
}

func newToolLoopGuard() *toolLoopGuard {
	return &toolLoopGuard{}
}

func (g *toolLoopGuard) observe(results []toolCallResult) (string, bool) {
	if len(results) == 0 {
		return "", false
	}

	signature := toolRoundSignature(results)
	resultKey := toolRoundResultKey(results)
	if signature == g.lastSignature && resultKey == g.lastResultKey {
		g.stagnant++
	} else {
		g.stagnant = 0
		g.lastSignature = signature
		g.lastResultKey = resultKey
	}

	if allToolResultsAreErrors(results) {
		g.errorRounds++
	} else {
		g.errorRounds = 0
	}

	if g.stagnant >= maxConsecutiveStagnantRounds {
		return "the model repeated the same tool call and received the same result without making progress", true
	}
	if g.errorRounds >= maxConsecutiveToolErrorRounds {
		return "tools returned errors repeatedly without a recoverable path", true
	}
	return "", false
}

func toolRoundSignature(results []toolCallResult) string {
	parts := make([]string, 0, len(results))
	for _, r := range results {
		parts = append(parts, r.call.Function.Name+":"+canonicalJSONish(r.call.Function.Arguments))
	}
	return strings.Join(parts, "\n")
}

func toolRoundResultKey(results []toolCallResult) string {
	h := sha256.New()
	for _, r := range results {
		h.Write([]byte(r.call.Function.Name))
		h.Write([]byte{0})
		h.Write([]byte(normalizeToolOutput(r.output)))
		h.Write([]byte{0})
	}
	return fmt.Sprintf("%x", h.Sum(nil))
}

func canonicalJSONish(raw string) string {
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		return strings.TrimSpace(raw)
	}
	b, err := json.Marshal(v)
	if err != nil {
		return strings.TrimSpace(raw)
	}
	return string(b)
}

func normalizeToolOutput(output string) string {
	return strings.Join(strings.Fields(output), " ")
}

func allToolResultsAreErrors(results []toolCallResult) bool {
	for _, r := range results {
		out := strings.TrimSpace(strings.ToLower(r.output))
		if !strings.HasPrefix(out, "error:") {
			return false
		}
	}
	return true
}
