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
				Name: "terminal_quick_command",
				Description: "Send one of the user's configured quick commands to the currently active terminal. " +
					"Identify it by quick-command name/label, by shortcut such as Ctrl+1 through Ctrl+9, or both. " +
					"Include group when the same name or shortcut could exist in more than one quick-command group.",
				Parameters: json.RawMessage(`{
					"type": "object",
					"properties": {
						"name": {"type": "string", "description": "The configured quick-command label/name."},
						"shortcut": {"type": "string", "description": "The quick-command keyboard shortcut, for example Ctrl+1, Control+1, ^1, or ⌃1."},
						"group": {"type": "string", "description": "Optional quick-command group name used to disambiguate matches."}
					}
				}`),
			},
		},
		{
			Type: "function",
			Function: ToolFunction{
				Name:        "open_url",
				Description: "Open a known URL or domain name and return readable page content.",
				Parameters: json.RawMessage(`{
					"type": "object",
					"properties": {
						"url": {"type": "string", "description": "The URL or domain to open. Bare domains such as example.com are accepted."}
					},
					"required": ["url"]
				}`),
			},
		},
		{
			Type: "function",
			Function: ToolFunction{
				Name: "read_local_file",
				Description: "Read the contents of a file on the local machine running iShell (not a remote SSH host). " +
					"Use this when the user references a local file or project path so you can inspect the actual source. " +
					"Returns content with 1-based line numbers so you can cite exact lines. For large files, pass " +
					"start_line/end_line to page through a specific range; binary files are rejected. If the path turns " +
					"out to be a directory, call list_local_dir instead.",
				Parameters: json.RawMessage(`{
					"type": "object",
					"properties": {
						"path": {"type": "string", "description": "Absolute path, or a ~/-relative path, to the local file to read."},
						"start_line": {"type": "integer", "description": "Optional 1-based line number to start reading from. Defaults to 1."},
						"end_line": {"type": "integer", "description": "Optional 1-based inclusive line number to stop at. Defaults to the end of file (subject to the output size limit)."}
					},
					"required": ["path"]
				}`),
			},
		},
		{
			Type: "function",
			Function: ToolFunction{
				Name: "list_local_dir",
				Description: "List the files and subdirectories of a directory on the local machine running iShell (not " +
					"a remote SSH host). Use this to explore a local project's structure, e.g. before reading specific " +
					"files with read_local_file, or to locate a file the user only vaguely described.",
				Parameters: json.RawMessage(`{
					"type": "object",
					"properties": {
						"path": {"type": "string", "description": "Absolute path, or a ~/-relative path, to the local directory to list."}
					},
					"required": ["path"]
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
