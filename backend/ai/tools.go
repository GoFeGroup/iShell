package ai

import (
	"encoding/json"
	"fmt"
	"regexp"

	"ishell/backend/storage"
)

// AgentTools returns the function-calling tools exposed to the model.
func AgentTools() []Tool {
	return []Tool{
		{
			Type: "function",
			Function: ToolFunction{
				Name: "terminal_run",
				Description: "Send a command to the user's currently active terminal, as if they typed it " +
					"and pressed Enter, and return the output captured shortly after.",
				Parameters: json.RawMessage(`{
					"type": "object",
					"properties": {
						"command": {"type": "string", "description": "The shell command or text input to send to the terminal."}
					},
					"required": ["command"]
				}`),
			},
		},
		{
			Type: "function",
			Function: ToolFunction{
				Name: "terminal_read",
				Description: "Read the terminal's most recent output without sending any input. Use this to " +
					"check on a long-running command you previously started with terminal_run.",
				Parameters: json.RawMessage(`{"type": "object", "properties": {}}`),
			},
		},
		{
			Type: "function",
			Function: ToolFunction{
				Name: "websearch",
				Description: "Search the web for current or external information and return a concise " +
					"summary with result titles and links. Use this when the user's question needs up-to-date facts.",
				Parameters: json.RawMessage(`{
					"type": "object",
					"properties": {
						"query": {"type": "string", "description": "The web search query."}
					},
					"required": ["query"]
				}`),
			},
		},
	}
}

// builtinToolNames lists every name AgentTools() registers, used to reject
// custom tool calls that would collide with a built-in tool.
func builtinToolNames() map[string]bool {
	names := make(map[string]bool)
	for _, tool := range AgentTools() {
		names[tool.Function.Name] = true
	}
	return names
}

// BuildToolList returns the tools exposed to the model for one turn: the
// built-in tools plus every enabled custom tool, converted to OpenAI
// function schemas. Custom tool parameters are all declared as strings —
// the model's job is just to fill in values for a shell command template.
func BuildToolList(custom []storage.CustomToolCall) []Tool {
	tools := AgentTools()
	for _, c := range custom {
		if !c.Enabled {
			continue
		}
		tools = append(tools, customToolSchema(c))
	}
	return tools
}

func customToolSchema(c storage.CustomToolCall) Tool {
	properties := make(map[string]any, len(c.Parameters))
	required := make([]string, 0, len(c.Parameters))
	for _, p := range c.Parameters {
		properties[p.Name] = map[string]string{"type": "string", "description": p.Description}
		if p.Required {
			required = append(required, p.Name)
		}
	}
	schema := map[string]any{
		"type":       "object",
		"properties": properties,
	}
	if len(required) > 0 {
		schema["required"] = required
	}
	params, err := json.Marshal(schema)
	if err != nil {
		params = json.RawMessage(`{"type":"object","properties":{}}`)
	}
	return Tool{
		Type: "function",
		Function: ToolFunction{
			Name:        c.Name,
			Description: c.Description,
			Parameters:  params,
		},
	}
}

// BuiltinToolInfo is the read-only view of a built-in tool shown in the
// settings page — name and description only, no JSON Schema.
type BuiltinToolInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// BuiltinToolInfos derives the settings-page listing from AgentTools(), so
// the built-in tool list never drifts out of sync with what the agent
// actually registers.
func BuiltinToolInfos() []BuiltinToolInfo {
	tools := AgentTools()
	infos := make([]BuiltinToolInfo, 0, len(tools))
	for _, tool := range tools {
		infos = append(infos, BuiltinToolInfo{Name: tool.Function.Name, Description: tool.Function.Description})
	}
	return infos
}

var toolNamePattern = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_]{0,63}$`)

// ValidateCustomToolCalls checks custom tool definitions before they are
// persisted: names must be valid OpenAI function identifiers, must not
// collide with a built-in tool or each other, and the command template must
// not be empty.
func ValidateCustomToolCalls(custom []storage.CustomToolCall) error {
	builtin := builtinToolNames()
	seen := make(map[string]bool, len(custom))
	for _, c := range custom {
		if !toolNamePattern.MatchString(c.Name) {
			return fmt.Errorf("tool name %q is invalid: must start with a letter and contain only letters, digits, or underscores (max 64 chars)", c.Name)
		}
		if builtin[c.Name] {
			return fmt.Errorf("tool name %q conflicts with a built-in tool", c.Name)
		}
		if seen[c.Name] {
			return fmt.Errorf("duplicate tool name %q", c.Name)
		}
		seen[c.Name] = true
		if c.CommandTemplate == "" {
			return fmt.Errorf("tool %q is missing a command template", c.Name)
		}
	}
	return nil
}
