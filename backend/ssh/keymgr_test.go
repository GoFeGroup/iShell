package ssh

import (
	"path/filepath"
	"runtime"
	"testing"
)

func TestExpandUserPath(t *testing.T) {
	home := t.TempDir()
	setTestHome(t, home)

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

func setTestHome(t *testing.T, home string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", home)
		volume := filepath.VolumeName(home)
		rest := home[len(volume):]
		if volume != "" {
			t.Setenv("HOMEDRIVE", volume)
			t.Setenv("HOMEPATH", rest)
		}
		return
	}
	t.Setenv("HOME", home)
}
