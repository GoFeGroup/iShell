package backend

import (
	"os"
	"path/filepath"
	"testing"
)

func newZmodemTestApp() *App {
	return &App{zmodemFiles: make(map[string]*os.File)}
}

func TestAbortZmodemFileRemovesPartialFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "partial.bin")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	app := newZmodemTestApp()
	handle := app.registerZmodemFile(f)

	if err := app.WriteZmodemFileChunk(handle, "AQID"); err != nil {
		t.Fatalf("write chunk: %v", err)
	}
	if err := app.AbortZmodemFile(handle); err != nil {
		t.Fatalf("abort file: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("partial file still exists or stat returned unexpected error: %v", err)
	}
}

func TestCloseZmodemFilesClosesAndForgetsHandles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "open.bin")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	app := newZmodemTestApp()
	handle := app.registerZmodemFile(f)

	app.closeZmodemFiles()

	if len(app.zmodemFiles) != 0 {
		t.Fatalf("expected all handles removed, got %d", len(app.zmodemFiles))
	}
	if _, err := f.Write([]byte{1}); err == nil {
		t.Fatal("expected file to be closed")
	}
	if err := app.CloseZmodemUploadFile(handle); err != nil {
		t.Fatalf("closing an already-cleaned handle should be a no-op: %v", err)
	}
}
