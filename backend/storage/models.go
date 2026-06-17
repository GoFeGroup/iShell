package storage

type AuthType string

const (
	AuthPassword AuthType = "password"
	AuthKey      AuthType = "key"
	AuthAgent    AuthType = "agent"
)

type Session struct {
	ID            string   `json:"id"`
	Label         string   `json:"label"`
	Host          string   `json:"host"`
	Port          int      `json:"port"`
	Username      string   `json:"username"`
	AuthType      AuthType `json:"auth_type"`
	Password      string   `json:"password,omitempty"`
	KeyPath       string   `json:"key_path,omitempty"`
	Passphrase    string   `json:"passphrase,omitempty"`
	Group         string   `json:"group"`
	Keepalive     int      `json:"keepalive"`
	Timeout       int      `json:"timeout"`
	Encoding      string   `json:"encoding"`
	JumpHost      string   `json:"jump_host,omitempty"`
	JumpProfileID string   `json:"jump_profile_id,omitempty"`
	InitCommand   string   `json:"init_command,omitempty"`
	CreatedAt     string   `json:"created_at"`
	UpdatedAt     string   `json:"updated_at"`
}

type Settings struct {
	Theme             string         `json:"theme"`
	ColorScheme       string         `json:"color_scheme"`
	FontFamily        string         `json:"font_family"`
	FontSize          int            `json:"font_size"`
	LineHeight        float64        `json:"line_height"`
	Scrollback        int            `json:"scrollback"`
	CursorStyle       string         `json:"cursor_style"`
	CursorBlink       bool           `json:"cursor_blink"`
	CopyOnSelect      bool           `json:"copy_on_select"`
	BellStyle         string         `json:"bell_style"`
	Ligatures         bool           `json:"ligatures"`
	DefaultAuth       string         `json:"default_auth"`
	DefaultKeyPath    string         `json:"default_key_path"`
	StrictHostKey     bool           `json:"strict_host_key"`
	KnownHostsPath    string         `json:"known_hosts_path"`
	QuickCommands     []QuickCommand `json:"quick_commands"`
	ShowQuickCommands bool           `json:"show_quick_commands"`
}

type QuickCommand struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Command string `json:"command"`
}

func DefaultSettings() Settings {
	return Settings{
		Theme:             "dark",
		ColorScheme:       "catppuccin",
		FontFamily:        "Cascadia Code, JetBrains Mono, Consolas, monospace",
		FontSize:          16,
		LineHeight:        1.5,
		Scrollback:        10000,
		CursorStyle:       "block",
		CursorBlink:       true,
		CopyOnSelect:      false,
		BellStyle:         "visual",
		Ligatures:         true,
		DefaultAuth:       "key",
		StrictHostKey:     true,
		KnownHostsPath:    "",
		QuickCommands:     []QuickCommand{},
		ShowQuickCommands: true,
	}
}
