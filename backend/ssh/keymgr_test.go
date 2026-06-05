package ssh

import (
	"path/filepath"
	"testing"
)

func TestExpandUserPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	tests := []struct {
		name string
		path string
		want string
	}{
		{
			name: "tilde slash",
			path: "~/.ssh/id_rsa",
			want: filepath.Join(home, ".ssh", "id_rsa"),
		},
		{
			name: "home only",
			path: "~",
			want: home,
		},
		{
			name: "absolute path",
			path: filepath.Join(home, ".ssh", "custom_key"),
			want: filepath.Join(home, ".ssh", "custom_key"),
		},
		{
			name: "trim whitespace",
			path: "  ~/.ssh/id_rsa  ",
			want: filepath.Join(home, ".ssh", "id_rsa"),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := expandUserPath(tt.path)
			if err != nil {
				t.Fatalf("expandUserPath() error = %v", err)
			}
			if got != tt.want {
				t.Fatalf("expandUserPath() = %q, want %q", got, tt.want)
			}
		})
	}
}
