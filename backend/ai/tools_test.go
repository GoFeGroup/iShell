package ai

import (
	"testing"

	"ishell/backend/storage"
)

func TestValidateCustomToolCallsRejectsBuiltinNameCollision(t *testing.T) {
	err := ValidateCustomToolCalls([]storage.CustomToolCall{{
		Name:            "open_url",
		CommandTemplate: "echo hi",
	}})
	if err == nil {
		t.Fatal("expected error for name colliding with a built-in tool")
	}
}

func TestValidateCustomToolCallsRejectsDuplicateNames(t *testing.T) {
	err := ValidateCustomToolCalls([]storage.CustomToolCall{
		{Name: "git_log", CommandTemplate: "git log -n {{count}}"},
		{Name: "git_log", CommandTemplate: "git log --oneline"},
	})
	if err == nil {
		t.Fatal("expected error for duplicate custom tool names")
	}
}

func TestValidateCustomToolCallsRejectsEmptyTemplate(t *testing.T) {
	err := ValidateCustomToolCalls([]storage.CustomToolCall{{
		Name:            "git_log",
		CommandTemplate: "",
	}})
	if err == nil {
		t.Fatal("expected error for empty command template")
	}
}

func TestValidateCustomToolCallsRejectsInvalidName(t *testing.T) {
	cases := []string{"1git_log", "git-log", "git log", ""}
	for _, name := range cases {
		err := ValidateCustomToolCalls([]storage.CustomToolCall{{
			Name:            name,
			CommandTemplate: "echo hi",
		}})
		if err == nil {
			t.Fatalf("expected error for invalid tool name %q", name)
		}
	}
}

func TestValidateCustomToolCallsAcceptsValidDefinition(t *testing.T) {
	err := ValidateCustomToolCalls([]storage.CustomToolCall{{
		Name:            "git_log",
		Description:     "Show recent commits",
		CommandTemplate: "git log -n {{count}}",
		Parameters:      []storage.ToolCallParam{{Name: "count", Required: true}},
		Enabled:         true,
	}})
	if err != nil {
		t.Fatalf("expected no error for a valid tool definition, got %v", err)
	}
}

func TestBuildToolListIncludesBuiltinAndEnabledCustomTools(t *testing.T) {
	custom := []storage.CustomToolCall{
		{Name: "git_log", CommandTemplate: "git log -n {{count}}", Enabled: true},
		{Name: "disabled_tool", CommandTemplate: "echo hi", Enabled: false},
	}
	tools := BuildToolList(custom)

	names := make(map[string]bool, len(tools))
	for _, tool := range tools {
		names[tool.Function.Name] = true
	}

	for _, want := range []string{"terminal_run", "terminal_read", "websearch", "open_url", "git_log"} {
		if !names[want] {
			t.Fatalf("tool list missing %q; got %v", want, names)
		}
	}
	if names["disabled_tool"] {
		t.Fatal("disabled custom tool must not appear in the tool list sent to the model")
	}
	if len(tools) != len(AgentTools())+1 {
		t.Fatalf("tool count = %d, want %d (builtin + 1 enabled custom)", len(tools), len(AgentTools())+1)
	}
}

func TestBuiltinToolInfosMatchesAgentTools(t *testing.T) {
	infos := BuiltinToolInfos()
	tools := AgentTools()
	if len(infos) != len(tools) {
		t.Fatalf("BuiltinToolInfos() len = %d, want %d", len(infos), len(tools))
	}
	for i, tool := range tools {
		if infos[i].Name != tool.Function.Name || infos[i].Description != tool.Function.Description {
			t.Fatalf("info[%d] = %+v, want name=%q description=%q", i, infos[i], tool.Function.Name, tool.Function.Description)
		}
	}
}
