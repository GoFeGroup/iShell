package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"
)

const (
	maxLocalFileReadBytes   = 2 * 1024 * 1024 // hard cap on bytes read from disk per call
	maxLocalFileOutputBytes = 64 * 1024       // cap on bytes of file content sent back to the model
	maxLocalFileOutputLines = 2000            // cap on number of lines sent back to the model
	localFileSniffBytes     = 8000            // bytes sampled for binary detection
	maxListLocalDirEntries  = 500             // cap on directory entries listed
	localFileTruncation     = "\n... [truncated; pass start_line/end_line to read more]"
)

// resolveLocalPath expands a leading "~" or "~/" to the user's home
// directory, then resolves the result to a clean absolute path. Relative
// paths resolve against the iShell process's own working directory, not any
// terminal session's cwd — the tool descriptions call this out so the model
// prefers absolute or "~/"-relative paths.
func resolveLocalPath(raw string) (string, error) {
	p := strings.TrimSpace(raw)
	if p == "" {
		return "", fmt.Errorf("path is required")
	}
	if p == "~" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve home directory: %w", err)
		}
		p = home
	} else if strings.HasPrefix(p, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve home directory: %w", err)
		}
		p = filepath.Join(home, p[2:])
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", fmt.Errorf("resolve path %q: %w", raw, err)
	}
	return filepath.Clean(abs), nil
}

// looksBinary reports whether sample looks like binary content, using the
// same NUL-byte heuristic git and ripgrep use to classify files.
func looksBinary(sample []byte) bool {
	if len(sample) > localFileSniffBytes {
		sample = sample[:localFileSniffBytes]
	}
	return bytes.IndexByte(sample, 0) >= 0
}

// readLocalFile reads a local file's content and returns it formatted with
// 1-based line numbers, optionally restricted to [startLine, endLine].
func readLocalFile(rawPath string, startLine, endLine int) (string, error) {
	absPath, err := resolveLocalPath(rawPath)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(absPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("path not found: %s", absPath)
		}
		return "", fmt.Errorf("stat %s: %w", absPath, err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("%s is a directory, not a file; call list_local_dir instead", absPath)
	}

	f, err := os.Open(absPath)
	if err != nil {
		return "", fmt.Errorf("open %s: %w", absPath, err)
	}
	defer f.Close()

	data, diskTruncated, err := readLimited(f, maxLocalFileReadBytes)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", absPath, err)
	}
	if looksBinary(data) {
		return "", fmt.Errorf("%s appears to be a binary file; binary content is not supported by read_local_file", absPath)
	}

	lines := strings.Split(string(data), "\n")
	totalLines := len(lines)

	start := startLine
	if start <= 0 {
		start = 1
	}
	if start > totalLines {
		return "", fmt.Errorf("start_line %d is beyond the file's %d lines", start, totalLines)
	}
	end := endLine
	if end <= 0 || end > totalLines {
		end = totalLines
	}
	if end < start {
		end = start
	}

	selected := lines[start-1 : end]
	linesTruncated := false
	if len(selected) > maxLocalFileOutputLines {
		selected = selected[:maxLocalFileOutputLines]
		linesTruncated = true
	}

	var b strings.Builder
	fmt.Fprintf(&b, "Path: %s\n", absPath)
	fmt.Fprintf(&b, "Size: %d bytes\n", info.Size())
	if diskTruncated {
		fmt.Fprintf(&b, "Lines shown: %d-%d (file exceeds the %d-byte read limit; total line count beyond that point is unknown, use start_line/end_line to page through it)\n",
			start, start+len(selected)-1, maxLocalFileReadBytes)
	} else {
		fmt.Fprintf(&b, "Lines shown: %d-%d of %d total\n", start, start+len(selected)-1, totalLines)
	}
	b.WriteString("\n")
	for i, line := range selected {
		fmt.Fprintf(&b, "%6d\t%s\n", start+i, line)
	}
	if linesTruncated {
		b.WriteString(localFileTruncation)
	}

	out := b.String()
	if truncated, isTrunc := truncateWebReadText(out, maxLocalFileOutputBytes); isTrunc {
		return truncated, nil
	}
	return out, nil
}

type localDirEntry struct {
	name  string
	isDir bool
	size  int64
}

// listLocalDir lists the entries of a local directory, directories first,
// then alphabetically, capped at maxListLocalDirEntries.
func listLocalDir(rawPath string) (string, error) {
	absPath, err := resolveLocalPath(rawPath)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(absPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("path not found: %s", absPath)
		}
		return "", fmt.Errorf("stat %s: %w", absPath, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%s is not a directory; call read_local_file instead", absPath)
	}

	entries, err := os.ReadDir(absPath)
	if err != nil {
		return "", fmt.Errorf("list %s: %w", absPath, err)
	}

	list := make([]localDirEntry, 0, len(entries))
	for _, e := range entries {
		fi, err := e.Info()
		if err != nil {
			continue // skip entries we can't stat (e.g. broken symlinks)
		}
		list = append(list, localDirEntry{name: e.Name(), isDir: e.IsDir(), size: fi.Size()})
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].isDir != list[j].isDir {
			return list[i].isDir // directories first
		}
		return strings.ToLower(list[i].name) < strings.ToLower(list[j].name)
	})

	total := len(list)
	shown := list
	if total > maxListLocalDirEntries {
		shown = list[:maxListLocalDirEntries]
	}

	var b strings.Builder
	fmt.Fprintf(&b, "Path: %s\n", absPath)
	if total > maxListLocalDirEntries {
		fmt.Fprintf(&b, "%d entries (showing first %d)\n\n", total, maxListLocalDirEntries)
	} else {
		fmt.Fprintf(&b, "%d entries\n\n", total)
	}
	w := tabwriter.NewWriter(&b, 0, 4, 2, ' ', 0)
	for _, e := range shown {
		if e.isDir {
			fmt.Fprintf(w, "%s/\t<dir>\n", e.name)
		} else {
			fmt.Fprintf(w, "%s\t%d bytes\n", e.name, e.size)
		}
	}
	w.Flush()
	return strings.TrimSpace(b.String()), nil
}

func (ag *Agent) handleReadLocalFile(ctx context.Context, opts RunOptions, call ToolCall) string {
	var args struct {
		Path      string `json:"path"`
		StartLine int    `json:"start_line"`
		EndLine   int    `json:"end_line"`
	}
	_ = json.Unmarshal([]byte(call.Function.Arguments), &args)
	target := strings.TrimSpace(args.Path)
	if target == "" {
		return `error: read_local_file requires a non-empty "path"`
	}
	output, err := readLocalFile(target, args.StartLine, args.EndLine)
	if err != nil {
		output = fmt.Sprintf("error: %v", err)
	}
	ag.emit("ai:tool_result:"+opts.ChatID, map[string]any{
		"tool_call_id": call.ID, "tool": call.Function.Name, "command": target, "output": output, "auto": true,
	})
	return output
}

func (ag *Agent) handleListLocalDir(ctx context.Context, opts RunOptions, call ToolCall) string {
	var args struct {
		Path string `json:"path"`
	}
	_ = json.Unmarshal([]byte(call.Function.Arguments), &args)
	target := strings.TrimSpace(args.Path)
	if target == "" {
		return `error: list_local_dir requires a non-empty "path"`
	}
	output, err := listLocalDir(target)
	if err != nil {
		output = fmt.Sprintf("error: %v", err)
	}
	ag.emit("ai:tool_result:"+opts.ChatID, map[string]any{
		"tool_call_id": call.ID, "tool": call.Function.Name, "command": target, "output": output, "auto": true,
	})
	return output
}
