package storage

type AuthType string

const (
	AuthPassword AuthType = "password"
	AuthKey      AuthType = "key"
	AuthAgent    AuthType = "agent"
)

type Session struct {
	ID            string   `json:"id" yaml:"id"`
	Label         string   `json:"label" yaml:"label"`
	Host          string   `json:"host" yaml:"host"`
	Port          int      `json:"port" yaml:"port"`
	Username      string   `json:"username" yaml:"username"`
	AuthType      AuthType `json:"auth_type" yaml:"auth_type"`
	Password      string   `json:"password,omitempty" yaml:"password,omitempty"`
	KeyPath       string   `json:"key_path,omitempty" yaml:"key_path,omitempty"`
	Passphrase    string   `json:"passphrase,omitempty" yaml:"passphrase,omitempty"`
	Group         string   `json:"group" yaml:"group"`
	Keepalive     int      `json:"keepalive" yaml:"keepalive"`
	Timeout       int      `json:"timeout" yaml:"timeout"`
	Encoding      string   `json:"encoding" yaml:"encoding"`
	JumpHost      string   `json:"jump_host,omitempty" yaml:"jump_host,omitempty"`
	JumpProfileID string   `json:"jump_profile_id,omitempty" yaml:"jump_profile_id,omitempty"`
	InitCommand   string   `json:"init_command,omitempty" yaml:"init_command,omitempty"`
	ForwardAgent  bool     `json:"forward_agent,omitempty" yaml:"forward_agent,omitempty"`
	CreatedAt     string   `json:"created_at" yaml:"created_at"`
	UpdatedAt     string   `json:"updated_at" yaml:"updated_at"`
}

type ForwardType string

const (
	ForwardLocal   ForwardType = "local"
	ForwardRemote  ForwardType = "remote"
	ForwardDynamic ForwardType = "dynamic"
)

// PortForward is a persisted SSH tunnel rule scoped to a Session. Local/remote
// forwards use TargetHost/TargetPort; dynamic (SOCKS5) forwards ignore them.
type PortForward struct {
	ID         string      `json:"id" yaml:"id"`
	SessionID  string      `json:"session_id" yaml:"session_id"`
	Type       ForwardType `json:"type" yaml:"type"`
	BindAddr   string      `json:"bind_addr" yaml:"bind_addr"`
	BindPort   int         `json:"bind_port" yaml:"bind_port"`
	TargetHost string      `json:"target_host,omitempty" yaml:"target_host,omitempty"`
	TargetPort int         `json:"target_port,omitempty" yaml:"target_port,omitempty"`
	AutoStart  bool        `json:"auto_start" yaml:"auto_start"`
	Enabled    bool        `json:"enabled" yaml:"enabled"`
	CreatedAt  string      `json:"created_at" yaml:"created_at"`
	UpdatedAt  string      `json:"updated_at" yaml:"updated_at"`
}

type Settings struct {
	Theme               string              `json:"theme" yaml:"theme"`
	ColorScheme         string              `json:"color_scheme" yaml:"color_scheme"`
	FontFamily          string              `json:"font_family" yaml:"font_family"`
	FontSize            int                 `json:"font_size" yaml:"font_size"`
	LineHeight          float64             `json:"line_height" yaml:"line_height"`
	Scrollback          int                 `json:"scrollback" yaml:"scrollback"`
	CursorStyle         string              `json:"cursor_style" yaml:"cursor_style"`
	CursorBlink         bool                `json:"cursor_blink" yaml:"cursor_blink"`
	CopyOnSelect        bool                `json:"copy_on_select" yaml:"copy_on_select"`
	RightClickAction    string              `json:"right_click_action" yaml:"right_click_action"` // "menu" | "paste"
	BellStyle           string              `json:"bell_style" yaml:"bell_style"`
	Ligatures           bool                `json:"ligatures" yaml:"ligatures"`
	DefaultAuth         string              `json:"default_auth" yaml:"default_auth"`
	DefaultKeyPath      string              `json:"default_key_path" yaml:"default_key_path"`
	StrictHostKey       bool                `json:"strict_host_key" yaml:"strict_host_key"`
	KnownHostsPath      string              `json:"known_hosts_path" yaml:"known_hosts_path"`
	QuickCommands       []QuickCommand      `json:"quick_commands" yaml:"quick_commands"`
	QuickCommandGroups  []QuickCommandGroup `json:"quick_command_groups" yaml:"quick_command_groups"`
	ShowQuickCommands   bool                `json:"show_quick_commands" yaml:"show_quick_commands"`
	Language            string              `json:"language" yaml:"language"`
	AIEnabled           bool                `json:"ai_enabled" yaml:"ai_enabled"`
	AIProviders         []AIProvider        `json:"ai_providers" yaml:"ai_providers"`
	CustomToolCalls     []CustomToolCall    `json:"custom_tool_calls" yaml:"custom_tool_calls"`
}

// AIProvider is one configured OpenAI-compatible model service. The first
// entry in Settings.AIProviders is the default used when a chat session
// hasn't picked one explicitly.
type AIProvider struct {
	ID      string `json:"id" yaml:"id"`
	Name    string `json:"name" yaml:"name"`
	BaseURL string `json:"base_url" yaml:"base_url"`
	APIKey  string `json:"api_key" yaml:"api_key"`
	Model   string `json:"model" yaml:"model"`
}

// AIChatSession is a single AI chat conversation, managed from the AI
// sidebar. Not part of ExportData — chat history is local-only and never
// included in config export/import.
type AIChatSession struct {
	ID         string `json:"id" yaml:"id"`
	TargetID   string `json:"target_id" yaml:"target_id"` // bound terminal identity: SSH Session.ID, or "__local__"
	Title      string `json:"title" yaml:"title"`
	AutoExec   bool   `json:"auto_exec" yaml:"auto_exec"`
	ProviderID string `json:"provider_id" yaml:"provider_id"` // AIProvider.ID; "" means "use the default (first) provider"
	CreatedAt  string `json:"created_at" yaml:"created_at"`
	UpdatedAt  string `json:"updated_at" yaml:"updated_at"`
}

// AIChatMessage is one message in an AIChatSession's history. Messages are
// immutable once appended (no UpdatedAt).
type AIChatMessage struct {
	ID          string `json:"id" yaml:"id"`
	SessionID   string `json:"session_id" yaml:"session_id"`
	Role        string `json:"role" yaml:"role"` // "user" | "assistant" | "tool"
	Content     string `json:"content" yaml:"content"`
	ContextJSON string `json:"context_json,omitempty" yaml:"context_json,omitempty"`
	ToolCalls   string `json:"tool_calls,omitempty" yaml:"tool_calls,omitempty"`     // JSON array, assistant role only
	ToolCallID  string `json:"tool_call_id,omitempty" yaml:"tool_call_id,omitempty"` // set when role="tool"
	CreatedAt   string `json:"created_at" yaml:"created_at"`
}

// AIMessageContext is user-selected terminal context attached to one prompt.
type AIMessageContext struct {
	Kind      string `json:"kind"`
	Label     string `json:"label"`
	Content   string `json:"content"`
	Truncated bool   `json:"truncated,omitempty"`
}

type QuickCommand struct {
	ID      string `json:"id" yaml:"id"`
	Label   string `json:"label" yaml:"label"`
	Command string `json:"command" yaml:"command"`
}

type QuickCommandGroup struct {
	ID       string         `json:"id" yaml:"id"`
	Name     string         `json:"name" yaml:"name"`
	Commands []QuickCommand `json:"commands" yaml:"commands"`
}

type ToolCallParam struct {
	Name        string `json:"name" yaml:"name"`
	Description string `json:"description" yaml:"description"`
	Required    bool   `json:"required" yaml:"required"`
}

// CustomToolCall is a user-defined AI tool that executes as a terminal
// command template — the LLM-supplied parameters are substituted into
// CommandTemplate's {{name}} placeholders and the result is run through the
// same approval/auto-exec flow as the built-in terminal_run tool.
type CustomToolCall struct {
	ID              string          `json:"id" yaml:"id"`
	Name            string          `json:"name" yaml:"name"`
	Description     string          `json:"description" yaml:"description"`
	CommandTemplate string          `json:"command_template" yaml:"command_template"`
	Parameters      []ToolCallParam `json:"parameters" yaml:"parameters"`
	Enabled         bool            `json:"enabled" yaml:"enabled"`
}

func DefaultSettings() Settings {
	return Settings{
		Theme:               "dark",
		ColorScheme:         "catppuccin",
		FontFamily:          "Cascadia Code, JetBrains Mono, Consolas, monospace",
		FontSize:            16,
		LineHeight:          1.5,
		Scrollback:          10000,
		CursorStyle:         "block",
		CursorBlink:         true,
		CopyOnSelect:        false,
		RightClickAction:    "menu",
		BellStyle:           "visual",
		Ligatures:           true,
		DefaultAuth:         "key",
		StrictHostKey:       true,
		KnownHostsPath:      "",
		QuickCommands:       []QuickCommand{},
		QuickCommandGroups:  []QuickCommandGroup{},
		ShowQuickCommands:   true,
		Language:            "auto",
		AIEnabled:           false,
		AIProviders:         []AIProvider{},
		CustomToolCalls:     []CustomToolCall{},
	}
}
