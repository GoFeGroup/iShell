package ai

import "encoding/json"

// TerminalTools returns the function-calling tools exposed to the model so
// it can interact with the user's currently active terminal session.
func TerminalTools() []Tool {
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
	}
}
