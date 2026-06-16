package ssh

import (
	"context"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pkg/sftp"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// FileInfo is a JSON-serialisable directory entry.
type FileInfo struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	IsDir   bool   `json:"is_dir"`
	Mode    string `json:"mode"`
	ModTime string `json:"mod_time"`
}

// TransferProgress is emitted as a Wails event while a transfer runs.
type TransferProgress struct {
	TransferID string  `json:"transfer_id"`
	Name       string  `json:"name"`
	Action     string  `json:"action,omitempty"`
	Total      int64   `json:"total"`
	Done       int64   `json:"done"`
	Percent    float64 `json:"percent"`
	Speed      float64 `json:"speed_bps"`
	Finished   bool    `json:"finished"`
	ErrMsg     string  `json:"error,omitempty"`
}

type ProgressHandler func(TransferProgress)

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
			ModTime: e.ModTime().UTC().Format(time.RFC3339),
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
			ModTime: info.ModTime().UTC().Format(time.RFC3339),
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
	return UploadFileWithProgress(ctx, client, localPath, remotePath, nil)
}

func UploadFileWithProgress(ctx context.Context, client *sftp.Client, localPath, remotePath string, onProgress ProgressHandler) (string, error) {
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
		emitProgress(ctx, onProgress, transferID, name, "upload", 0, total, 0, false, "")
		start := time.Now()
		var done int64
		buf := make([]byte, 32*1024)
		for {
			n, err := src.Read(buf)
			if n > 0 {
				if _, werr := dst.Write(buf[:n]); werr != nil {
					emitProgress(ctx, onProgress, transferID, name, "upload", done, total, 0, true, werr.Error())
					return
				}
				done += int64(n)
				elapsed := time.Since(start).Seconds()
				var speed float64
				if elapsed > 0 {
					speed = float64(done) / elapsed
				}
				emitProgress(ctx, onProgress, transferID, name, "upload", done, total, speed, false, "")
			}
			if err == io.EOF {
				break
			}
			if err != nil {
				emitProgress(ctx, onProgress, transferID, name, "upload", done, total, 0, true, err.Error())
				return
			}
		}
		emitProgress(ctx, onProgress, transferID, name, "upload", total, total, 0, true, "")
	}()

	return transferID, nil
}

// ── Transfer: download ────────────────────────────────────────────────────────

// DownloadFile downloads a single remote file to localDir.
func DownloadFile(ctx context.Context, client *sftp.Client, remotePath, localDir string) (string, error) {
	return DownloadFileWithProgress(ctx, client, remotePath, localDir, nil)
}

func DownloadFileWithProgress(ctx context.Context, client *sftp.Client, remotePath, localDir string, onProgress ProgressHandler) (string, error) {
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
		emitProgress(ctx, onProgress, transferID, name, "download", 0, total, 0, false, "")
		start := time.Now()
		var done int64
		buf := make([]byte, 32*1024)
		for {
			n, err := src.Read(buf)
			if n > 0 {
				if _, werr := dst.Write(buf[:n]); werr != nil {
					emitProgress(ctx, onProgress, transferID, name, "download", done, total, 0, true, werr.Error())
					return
				}
				done += int64(n)
				elapsed := time.Since(start).Seconds()
				var speed float64
				if elapsed > 0 {
					speed = float64(done) / elapsed
				}
				emitProgress(ctx, onProgress, transferID, name, "download", done, total, speed, false, "")
			}
			if err == io.EOF {
				break
			}
			if err != nil {
				emitProgress(ctx, onProgress, transferID, name, "download", done, total, 0, true, err.Error())
				return
			}
		}
		emitProgress(ctx, onProgress, transferID, name, "download", total, total, 0, true, "")
	}()

	return transferID, nil
}

// DownloadPathWithProgress downloads a remote file or directory into localDir.
// Directory trees are processed one directory at a time, with heartbeat progress
// while large directory listings are being read.
func DownloadPathWithProgress(ctx context.Context, client *sftp.Client, remotePath, localDir string, onProgress ProgressHandler) (string, error) {
	info, err := client.Stat(remotePath)
	if err != nil {
		return "", fmt.Errorf("stat remote path: %w", err)
	}
	if !info.IsDir() {
		return DownloadFileWithProgress(ctx, client, remotePath, localDir, onProgress)
	}

	transferID := uuid.NewString()
	name := path.Base(remotePath)
	localRoot := filepath.Join(localDir, name)
	if err := os.MkdirAll(localRoot, 0o755); err != nil {
		return transferID, fmt.Errorf("create local directory: %w", err)
	}

	go func() {
		start := time.Now()
		var done int64
		var total int64
		var progressMu sync.Mutex
		var lastEmit time.Time

		emit := func(finished bool, errMsg string) {
			progressMu.Lock()
			snapshotDone := done
			snapshotTotal := total
			lastEmit = time.Now()
			progressMu.Unlock()

			elapsed := time.Since(start).Seconds()
			var speed float64
			if elapsed > 0 {
				speed = float64(snapshotDone) / elapsed
			}
			emitProgress(ctx, onProgress, transferID, name, "download", snapshotDone, snapshotTotal, speed, finished, errMsg)
		}
		maybeEmit := func() {
			progressMu.Lock()
			shouldEmit := time.Since(lastEmit) >= 200*time.Millisecond
			progressMu.Unlock()
			if shouldEmit {
				emit(false, "")
			}
		}
		addTotal := func(n int64) {
			progressMu.Lock()
			total += n
			progressMu.Unlock()
		}
		addDone := func(n int64) {
			progressMu.Lock()
			done += n
			progressMu.Unlock()
		}

		emit(false, "")
		doneCh := make(chan struct{})
		go func() {
			ticker := time.NewTicker(time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-doneCh:
					return
				case <-ticker.C:
					emit(false, "")
				}
			}
		}()
		defer close(doneCh)

		type dirJob struct {
			remote string
			local  string
		}
		stack := []dirJob{{remote: remotePath, local: localRoot}}
		buf := make([]byte, 32*1024)

		for len(stack) > 0 {
			job := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if err := os.MkdirAll(job.local, 0o755); err != nil {
				emit(true, err.Error())
				return
			}

			entries, err := client.ReadDir(job.remote)
			if err != nil {
				emit(true, fmt.Sprintf("list %s: %v", job.remote, err))
				return
			}
			maybeEmit()
			for _, entry := range entries {
				remoteChild := path.Join(job.remote, entry.Name())
				localChild := filepath.Join(job.local, entry.Name())
				if entry.IsDir() {
					stack = append(stack, dirJob{remote: remoteChild, local: localChild})
					continue
				}
				if !entry.Mode().IsRegular() {
					continue
				}
				addTotal(entry.Size())
				if err := downloadRemoteFile(client, remoteChild, localChild, buf, func(n int64) {
					addDone(n)
					maybeEmit()
				}); err != nil {
					emit(true, fmt.Sprintf("download %s: %v", remoteChild, err))
					return
				}
				maybeEmit()
			}
		}

		emit(true, "")
	}()

	return transferID, nil
}

func downloadRemoteFile(client *sftp.Client, remotePath, localPath string, buf []byte, onBytes func(int64)) error {
	src, err := client.Open(remotePath)
	if err != nil {
		return fmt.Errorf("open remote file: %w", err)
	}
	defer src.Close()

	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return fmt.Errorf("create local parent: %w", err)
	}
	dst, err := os.Create(localPath)
	if err != nil {
		return fmt.Errorf("create local file: %w", err)
	}
	defer dst.Close()

	for {
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return werr
			}
			onBytes(int64(n))
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func emitProgress(ctx context.Context, onProgress ProgressHandler, id, name, action string, done, total int64, speed float64, finished bool, errMsg string) {
	var pct float64
	if total > 0 {
		pct = float64(done) / float64(total) * 100
	}
	progress := TransferProgress{
		TransferID: id,
		Name:       name,
		Action:     action,
		Total:      total,
		Done:       done,
		Percent:    pct,
		Speed:      speed,
		Finished:   finished,
		ErrMsg:     errMsg,
	}
	if onProgress != nil {
		onProgress(progress)
		return
	}
	runtime.EventsEmit(ctx, "sftp:progress", progress)
}
