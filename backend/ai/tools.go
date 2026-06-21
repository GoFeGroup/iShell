package ai

import "encoding/json"

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
