package ssh

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"github.com/pkg/sftp"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// FileInfo is a JSON-serialisable directory entry.
type FileInfo struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"`
	Size    int64     `json:"size"`
	IsDir   bool      `json:"is_dir"`
	Mode    string    `json:"mode"`
	ModTime time.Time `json:"mod_time"`
}

// TransferProgress is emitted as a Wails event while a transfer runs.
type TransferProgress struct {
	TransferID string  `json:"transfer_id"`
	Name       string  `json:"name"`
	Total      int64   `json:"total"`
	Done       int64   `json:"done"`
	Percent    float64 `json:"percent"`
	Speed      float64 `json:"speed_bps"`
	Finished   bool    `json:"finished"`
	ErrMsg     string  `json:"error,omitempty"`
}

// ── Directory listing ─────────────────────────────────────────────────────────

func ListRemoteDir(client *sftp.Client, path string) ([]FileInfo, error) {
	entries, err := client.ReadDir(path)
	if err != nil {
		return nil, fmt.Errorf("list dir %s: %w", path, err)
	}
	infos := make([]FileInfo, 0, len(entries))
	for _, e := range entries {
		infos = append(infos, FileInfo{
			Name:    e.Name(),
			Path:    path + "/" + e.Name(),
			Size:    e.Size(),
			IsDir:   e.IsDir(),
			Mode:    e.Mode().String(),
			ModTime: e.ModTime(),
		})
	}
	return infos, nil
}

func ListLocalDir(path string) ([]FileInfo, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, fmt.Errorf("list local dir %s: %w", path, err)
	}
	infos := make([]FileInfo, 0, len(entries))
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		infos = append(infos, FileInfo{
			Name:    e.Name(),
			Path:    filepath.Join(path, e.Name()),
			Size:    info.Size(),
			IsDir:   e.IsDir(),
			Mode:    info.Mode().String(),
			ModTime: info.ModTime(),
		})
	}
	return infos, nil
}

// ── File operations ───────────────────────────────────────────────────────────

func MakeRemoteDir(client *sftp.Client, path string) error {
	return client.MkdirAll(path)
}

func DeleteRemote(client *sftp.Client, path string) error {
	// Try file first, then directory
	if err := client.Remove(path); err != nil {
		return client.RemoveAll(path)
	}
	return nil
}

func RenameRemote(client *sftp.Client, oldPath, newPath string) error {
	return client.Rename(oldPath, newPath)
}

func SetRemotePermissions(client *sftp.Client, path string, mode os.FileMode) error {
	return client.Chmod(path, mode)
}

// ── Transfer: upload ──────────────────────────────────────────────────────────

// UploadFile uploads a single local file to remotePath on the SFTP server.
// Progress is emitted as "sftp:progress" Wails events.
func UploadFile(ctx context.Context, client *sftp.Client, localPath, remotePath string) (string, error) {
	transferID := uuid.NewString()

	src, err := os.Open(localPath)
	if err != nil {
		return transferID, fmt.Errorf("open local file: %w", err)
	}

	info, _ := src.Stat()
	total := info.Size()
	name := filepath.Base(localPath)

	dst, err := client.Create(remotePath)
	if err != nil {
		src.Close()
		return transferID, fmt.Errorf("create remote file: %w", err)
	}

	go func() {
		defer src.Close()
		defer dst.Close()
		emitProgress(ctx, transferID, name, 0, total, 0, false, "")
		start := time.Now()
		var done int64
		buf := make([]byte, 32*1024)
		for {
			n, err := src.Read(buf)
			if n > 0 {
				if _, werr := dst.Write(buf[:n]); werr != nil {
					emitProgress(ctx, transferID, name, done, total, 0, true, werr.Error())
					return
				}
				done += int64(n)
				elapsed := time.Since(start).Seconds()
				var speed float64
				if elapsed > 0 {
					speed = float64(done) / elapsed
				}
				emitProgress(ctx, transferID, name, done, total, speed, false, "")
			}
			if err == io.EOF {
				break
			}
			if err != nil {
				emitProgress(ctx, transferID, name, done, total, 0, true, err.Error())
				return
			}
		}
		emitProgress(ctx, transferID, name, total, total, 0, true, "")
	}()

	return transferID, nil
}

// ── Transfer: download ────────────────────────────────────────────────────────

// DownloadFile downloads a single remote file to localDir.
func DownloadFile(ctx context.Context, client *sftp.Client, remotePath, localDir string) (string, error) {
	transferID := uuid.NewString()

	src, err := client.Open(remotePath)
	if err != nil {
		return transferID, fmt.Errorf("open remote file: %w", err)
	}

	info, _ := src.Stat()
	total := info.Size()
	name := filepath.Base(remotePath)

	localPath := filepath.Join(localDir, name)
	dst, err := os.Create(localPath)
	if err != nil {
		src.Close()
		return transferID, fmt.Errorf("create local file: %w", err)
	}

	go func() {
		defer src.Close()
		defer dst.Close()
		emitProgress(ctx, transferID, name, 0, total, 0, false, "")
		start := time.Now()
		var done int64
		buf := make([]byte, 32*1024)
		for {
			n, err := src.Read(buf)
			if n > 0 {
				if _, werr := dst.Write(buf[:n]); werr != nil {
					emitProgress(ctx, transferID, name, done, total, 0, true, werr.Error())
					return
				}
				done += int64(n)
				elapsed := time.Since(start).Seconds()
				var speed float64
				if elapsed > 0 {
					speed = float64(done) / elapsed
				}
				emitProgress(ctx, transferID, name, done, total, speed, false, "")
			}
			if err == io.EOF {
				break
			}
			if err != nil {
				emitProgress(ctx, transferID, name, done, total, 0, true, err.Error())
				return
			}
		}
		emitProgress(ctx, transferID, name, total, total, 0, true, "")
	}()

	return transferID, nil
}

func emitProgress(ctx context.Context, id, name string, done, total int64, speed float64, finished bool, errMsg string) {
	var pct float64
	if total > 0 {
		pct = float64(done) / float64(total) * 100
	}
	runtime.EventsEmit(ctx, "sftp:progress", TransferProgress{
		TransferID: id,
		Name:       name,
		Total:      total,
		Done:       done,
		Percent:    pct,
		Speed:      speed,
		Finished:   finished,
		ErrMsg:     errMsg,
	})
}
