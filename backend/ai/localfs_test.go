package ai

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestReadLocalFileReturnsContentWithLineNumbers(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sample.go")
	if err := os.WriteFile(path, []byte("line one\nline two\nline three"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	out, err := readLocalFile(path, 0, 0)
	if err != nil {
		t.Fatalf("readLocalFile: %v", err)
	}
	for _, want := range []string{"Path: " + path, "Lines shown: 1-3 of 3 total", "line one", "line two", "line three"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output missing %q:\n%s", want, out)
		}
	}
}

func TestReadLocalFileRespectsStartEndLine(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sample.txt")
	if err := os.WriteFile(path, []byte("a\nb\nc\nd\ne"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	out, err := readLocalFile(path, 2, 3)
	if err != nil {
		t.Fatalf("readLocalFile: %v", err)
	}
	if !strings.Contains(out, "Lines shown: 2-3 of 5 total") {
		t.Fatalf("output missing expected range header:\n%s", out)
	}
	for _, unwanted := range []string{"\ta\n", "\td\n", "\te\n"} {
		if strings.Contains(out, unwanted) {
			t.Fatalf("output should not include line outside range %q:\n%s", unwanted, out)
		}
	}
	if !strings.Contains(out, "\tb\n") || !strings.Contains(out, "\tc\n") {
		t.Fatalf("output missing requested range content:\n%s", out)
	}
}

func TestReadLocalFileRejectsDirectory(t *testing.T) {
	dir := t.TempDir()
	_, err := readLocalFile(dir, 0, 0)
	if err == nil {
		t.Fatal("expected error reading a directory as a file")
	}
	if !strings.Contains(err.Error(), "list_local_dir") {
		t.Fatalf("error should hint at list_local_dir: %v", err)
	}
}

func TestReadLocalFileRejectsMissingPath(t *testing.T) {
	_, err := readLocalFile(filepath.Join(t.TempDir(), "does-not-exist.txt"), 0, 0)
	if err == nil {
		t.Fatal("expected error for missing path")
	}
	if !strings.Contains(err.Error(), "path not found") {
		t.Fatalf("error should mention path not found: %v", err)
	}
}

func TestReadLocalFileRejectsBinary(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "binary.bin")
	if err := os.WriteFile(path, []byte("PNG\x00\x01\x02garbage"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	_, err := readLocalFile(path, 0, 0)
	if err == nil {
		t.Fatal("expected error reading a binary file")
	}
	if !strings.Contains(err.Error(), "binary file") {
		t.Fatalf("error should mention binary file: %v", err)
	}
}

func TestReadLocalFileTruncatesManyLines(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "many-lines.txt")
	lines := make([]string, maxLocalFileOutputLines+10)
	for i := range lines {
		lines[i] = "x"
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	out, err := readLocalFile(path, 0, 0)
	if err != nil {
		t.Fatalf("readLocalFile: %v", err)
	}
	if !strings.Contains(out, "truncated") {
		t.Fatalf("expected truncation notice in output:\n%s", out[:200])
	}
}

func TestResolveLocalPathExpandsTilde(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("no home dir available: %v", err)
	}
	got, err := resolveLocalPath("~/foo/bar")
	if err != nil {
		t.Fatalf("resolveLocalPath: %v", err)
	}
	want := filepath.Join(home, "foo", "bar")
	if got != want {
		t.Fatalf("resolveLocalPath(~/foo/bar) = %q, want %q", got, want)
	}
}

func TestResolveLocalPathRejectsEmpty(t *testing.T) {
	if _, err := resolveLocalPath("   "); err == nil {
		t.Fatal("expected error for empty path")
	}
}

func TestListLocalDirSortsDirsFirstThenName(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"zeta.txt", "alpha.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}

	out, err := listLocalDir(dir)
	if err != nil {
		t.Fatalf("listLocalDir: %v", err)
	}
	subIdx := strings.Index(out, "sub/")
	alphaIdx := strings.Index(out, "alpha.txt")
	zetaIdx := strings.Index(out, "zeta.txt")
	if subIdx == -1 || alphaIdx == -1 || zetaIdx == -1 {
		t.Fatalf("output missing expected entries:\n%s", out)
	}
	if !(subIdx < alphaIdx && alphaIdx < zetaIdx) {
		t.Fatalf("expected directory-first, alphabetical order, got:\n%s", out)
	}
}

func TestListLocalDirRejectsFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "file.txt")
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	_, err := listLocalDir(path)
	if err == nil {
		t.Fatal("expected error listing a file as a directory")
	}
	if !strings.Contains(err.Error(), "read_local_file") {
		t.Fatalf("error should hint at read_local_file: %v", err)
	}
}

func TestListLocalDirRejectsMissingPath(t *testing.T) {
	_, err := listLocalDir(filepath.Join(t.TempDir(), "does-not-exist"))
	if err == nil {
		t.Fatal("expected error for missing directory")
	}
	if !strings.Contains(err.Error(), "path not found") {
		t.Fatalf("error should mention path not found: %v", err)
	}
}

func TestListLocalDirCapsEntries(t *testing.T) {
	dir := t.TempDir()
	for i := range maxListLocalDirEntries + 5 {
		name := filepath.Join(dir, fmt.Sprintf("f%05d.txt", i))
		if err := os.WriteFile(name, []byte("x"), 0o644); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
	}

	out, err := listLocalDir(dir)
	if err != nil {
		t.Fatalf("listLocalDir: %v", err)
	}
	if !strings.Contains(out, "showing first "+strconv.Itoa(maxListLocalDirEntries)) {
		t.Fatalf("expected truncation notice mentioning cap, got:\n%s", out[:strings.IndexByte(out, '\n')])
	}
}
