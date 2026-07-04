package backend

import (
	"strings"
	"testing"

	"ishell/backend/storage"
)

func TestSanitizeAIContexts(t *testing.T) {
	input := []storage.AIMessageContext{
		{Kind: "", Label: "ignored", Content: "x"},
		{Kind: "terminal_output", Label: strings.Repeat("l", 200), Content: strings.Repeat("x", maxAIContextBytes+20)},
	}
	got := sanitizeAIContexts(input)
	if len(got) != 1 || len(got[0].Label) != 160 || len(got[0].Content) != maxAIContextBytes || !got[0].Truncated {
		t.Fatalf("unexpected sanitized contexts: %#v", got)
	}
}
