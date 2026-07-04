package storage

import "testing"

// TestListAIChatMessagesPreservesInsertionOrder guards against a regression
// where messages were ordered by (created_at, id). created_at only has
// second resolution, so messages appended within the same agent turn (an
// assistant tool_calls message followed immediately by its tool results)
// commonly tie, and the query fell back to sorting by id — a random UUID
// unrelated to insertion order. That could reorder a "tool" message ahead of
// the assistant message that produced it, which OpenAI-style chat APIs
// reject. All messages below share one created_at and have ids assigned in
// reverse of insertion order, so an id-based tiebreak would return them
// backwards; ordering by rowid must still return them in insertion order.
func TestListAIChatMessagesPreservesInsertionOrder(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	sess, err := st.SaveAIChatSession(AIChatSession{TargetID: "__local__"})
	if err != nil {
		t.Fatalf("save session: %v", err)
	}

	const sameTimestamp = "2026-06-22T10:00:00Z"
	inserted := []AIChatMessage{
		{ID: "id-5", SessionID: sess.ID, Role: "user", Content: "list files", ContextJSON: `[{"kind":"terminal_selection","label":"selection","content":"ls"}]`, CreatedAt: sameTimestamp},
		{ID: "id-4", SessionID: sess.ID, Role: "assistant", Content: "", ToolCalls: `[{"id":"call_1","type":"function","function":{"name":"terminal_run","arguments":"{}"}}]`, CreatedAt: sameTimestamp},
		{ID: "id-3", SessionID: sess.ID, Role: "tool", Content: "file1\nfile2", ToolCallID: "call_1", CreatedAt: sameTimestamp},
		{ID: "id-2", SessionID: sess.ID, Role: "assistant", Content: "here are your files", CreatedAt: sameTimestamp},
		{ID: "id-1", SessionID: sess.ID, Role: "user", Content: "thanks", CreatedAt: sameTimestamp},
		{ID: "id-0", SessionID: sess.ID, Role: "assistant", Content: "you're welcome", CreatedAt: sameTimestamp},
	}
	for i, msg := range inserted {
		if _, err := st.AppendAIChatMessage(msg); err != nil {
			t.Fatalf("append message %d: %v", i, err)
		}
	}

	got, err := st.ListAIChatMessages(sess.ID)
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	if len(got) != len(inserted) {
		t.Fatalf("expected %d messages, got %d", len(inserted), len(got))
	}
	for i, want := range inserted {
		if got[i].ID != want.ID || got[i].Role != want.Role {
			t.Fatalf("message %d out of order: want id=%s role=%s, got id=%s role=%s",
				i, want.ID, want.Role, got[i].ID, got[i].Role)
		}
	}
	if got[0].ContextJSON != inserted[0].ContextJSON {
		t.Fatalf("context JSON did not round-trip: got %q", got[0].ContextJSON)
	}

	// The tool message must directly follow the assistant message that
	// declared the matching tool_calls[].id, exactly as OpenAI-style APIs
	// require.
	for i, m := range got {
		if m.Role != "tool" {
			continue
		}
		prev := got[i-1]
		if prev.Role != "assistant" || prev.ToolCalls == "" {
			t.Fatalf("tool message %s at index %d is not preceded by an assistant tool_calls message (preceded by role=%s)", m.ID, i, prev.Role)
		}
	}
}
