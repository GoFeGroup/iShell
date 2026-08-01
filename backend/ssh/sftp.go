package ssh

import (
	"context"
	"errors"
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
	Cancelled  bool    `json:"cancelled,omitempty"`
	ErrMsg     string  `json:"error,omitempty"`
}

type ProgressHandler func(TransferProgress)

// progressInterval throttles intermediate progress events.
const progressInterval = 200 * time.Millisecond

// ctxReader counts bytes read from r and aborts once ctx is cancelled.
type ctxReader struct {
	ctx     context.Context
	r       io.Reader
	onBytes func(int64)
}

func (cr *ctxReader) Read(p []byte) (int, error) {
	select {
	case <-cr.ctx.Done():
		return 0, cr.ctx.Err()
	default:
	}
	n, err := cr.r.Read(p)
	if n > 0 && cr.onBytes != nil {
		cr.onBytes(int64(n))
	}
	return n, err
}

// ctxWriter counts bytes written to w and aborts once ctx is cancelled.
type ctxWriter struct {
	ctx     context.Context
	w       io.Writer
	onBytes func(int64)
}

func (cw *ctxWriter) Write(p []byte) (int, error) {
	select {
	case <-cw.ctx.Done():
		return 0, cw.ctx.Err()
	default:
	}
	n, err := cw.w.Write(p)
	if n > 0 && cw.onBytes != nil {
		cw.onBytes(int64(n))
	}
	return n, err
}

// transferReporter accumulates bytes transferred for one file and emits
// throttled progress events, shared by the upload and download paths.
type transferReporter struct {
	ctx        context.Context
	onProgress ProgressHandler
	transferID string
	name       string
	action     string
	total      int64
	start      time.Time

	mu       sync.Mutex
	done     int64
	lastEmit time.Time
}

func newTransferReporter(ctx context.Context, onProgress ProgressHandler, transferID, name, action string, total int64) *transferReporter {
	return &transferReporter{
		ctx:        ctx,
		onProgress: onProgress,
		transferID: transferID,
		name:       name,
		action:     action,
		total:      total,
		start:      time.Now(),
	}
}

func (tr *transferReporter) emitStart() {
	tr.mu.Lock()
	tr.lastEmit = time.Now()
	tr.mu.Unlock()
	emitProgress(tr.ctx, tr.onProgress, tr.transferID, tr.name, tr.action, 0, tr.total, 0, false, false, "")
}

// add records n more transferred bytes and emits a throttled progress event.
func (tr *transferReporter) add(n int64) {
	tr.mu.Lock()
	tr.done += n
	done := tr.done
	shouldEmit := time.Since(tr.lastEmit) >= progressInterval
	if shouldEmit {
		tr.lastEmit = time.Now()
	}
	tr.mu.Unlock()
	if !shouldEmit {
		return
	}
	var speed float64
	if elapsed := time.Since(tr.start).Seconds(); elapsed > 0 {
		speed = float64(done) / elapsed
	}
	emitProgress(tr.ctx, tr.onProgress, tr.transferID, tr.name, tr.action, done, tr.total, speed, false, false, "")
}

// finish emits the terminal progress event for the transfer, mapping a
// cancelled ctx to the cancelled state rather than an error.
func (tr *transferReporter) finish(err error) {
	tr.mu.Lock()
	done := tr.done
	tr.mu.Unlock()
	switch {
	case err == nil:
		emitProgress(tr.ctx, tr.onProgress, tr.transferID, tr.name, tr.action, tr.total, tr.total, 0, true, false, "")
	case errors.Is(err, context.Canceled) || tr.ctx.Err() != nil:
		emitProgress(tr.ctx, tr.onProgress, tr.transferID, tr.name, tr.action, done, tr.total, 0, true, true, "")
	default:
		emitProgress(tr.ctx, tr.onProgress, tr.transferID, tr.name, tr.action, done, tr.total, 0, true, false, err.Error())
	}
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
	transferID := uuid.NewString()
	return transferID, UploadFileWithProgress(ctx, transferID, client, localPath, remotePath, nil)
}

// UploadFileWithProgress uploads localPath to remotePath under transferID,
// which the caller generates up front so it can be cancelled (by cancelling
// ctx) before the transfer goroutine even starts.
func UploadFileWithProgress(ctx context.Context, transferID string, client *sftp.Client, localPath, remotePath string, onProgress ProgressHandler) error {
	src, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("open local file: %w", err)
	}

	var total int64
	if info, err := src.Stat(); err == nil {
		total = info.Size()
	}
	name := filepath.Base(localPath)

	dst, err := client.Create(remotePath)
	if err != nil {
		src.Close()
		return fmt.Errorf("create remote file: %w", err)
	}

	go func() {
		defer src.Close()
		defer dst.Close()
		tr := newTransferReporter(ctx, onProgress, transferID, name, "upload", total)
		tr.emitStart()
		counted := io.Reader(&ctxReader{ctx: ctx, r: src, onBytes: tr.add})
		if total > 0 {
			// sftp.File.ReadFrom only pipelines write requests when it can see
			// the remaining size on the reader's concrete type; an opaque
			// wrapper would silently fall back to one packet per round-trip.
			// *io.LimitedReader is one of the types it inspects.
			counted = &io.LimitedReader{R: counted, N: total}
		}
		_, err := dst.ReadFrom(counted)
		tr.finish(err)
	}()

	return nil
}

// ── Transfer: download ────────────────────────────────────────────────────────

// DownloadFile downloads a single remote file to localDir.
func DownloadFile(ctx context.Context, client *sftp.Client, remotePath, localDir string) (string, error) {
	transferID := uuid.NewString()
	return transferID, DownloadFileWithProgress(ctx, transferID, client, remotePath, localDir, nil)
}

// DownloadFileWithProgress downloads remotePath into localDir under
// transferID, which the caller generates up front so it can be cancelled (by
// cancelling ctx) before the transfer goroutine even starts.
func DownloadFileWithProgress(ctx context.Context, transferID string, client *sftp.Client, remotePath, localDir string, onProgress ProgressHandler) error {
	src, err := client.Open(remotePath)
	if err != nil {
		return fmt.Errorf("open remote file: %w", err)
	}

	var total int64
	if info, err := src.Stat(); err == nil {
		total = info.Size()
	}
	name := filepath.Base(remotePath)

	localPath := filepath.Join(localDir, name)
	dst, err := os.Create(localPath)
	if err != nil {
		src.Close()
		return fmt.Errorf("create local file: %w", err)
	}

	go func() {
		defer src.Close()
		defer dst.Close()
		tr := newTransferReporter(ctx, onProgress, transferID, name, "download", total)
		tr.emitStart()
		// WriteTo pipelines read requests (sftp enables concurrent reads by
		// default) and reassembles chunks in order before writing, so the
		// counting writer still observes strictly sequential progress.
		_, err := src.WriteTo(&ctxWriter{ctx: ctx, w: dst, onBytes: tr.add})
		tr.finish(err)
	}()

	return nil
}

// DownloadPathWithProgress downloads a remote file or directory into localDir
// under transferID. Directory trees are processed one directory at a time,
// with heartbeat progress while large directory listings are being read, and
// a cancellation check before each directory/file so a cancelled ctx stops
// the walk promptly between entries.
func DownloadPathWithProgress(ctx context.Context, transferID string, client *sftp.Client, remotePath, localDir string, onProgress ProgressHandler) error {
	info, err := client.Stat(remotePath)
	if err != nil {
		return fmt.Errorf("stat remote path: %w", err)
	}
	if !info.IsDir() {
		return DownloadFileWithProgress(ctx, transferID, client, remotePath, localDir, onProgress)
	}

	name := path.Base(remotePath)
	localRoot := filepath.Join(localDir, name)
	if err := os.MkdirAll(localRoot, 0o755); err != nil {
		return fmt.Errorf("create local directory: %w", err)
	}

	go func() {
		start := time.Now()
		var done int64
		var total int64
		var progressMu sync.Mutex
		var lastEmit time.Time

		emit := func(finished, cancelled bool, errMsg string) {
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
			emitProgress(ctx, onProgress, transferID, name, "download", snapshotDone, snapshotTotal, speed, finished, cancelled, errMsg)
		}
		maybeEmit := func() {
			progressMu.Lock()
			shouldEmit := time.Since(lastEmit) >= 200*time.Millisecond
			progressMu.Unlock()
			if shouldEmit {
				emit(false, false, "")
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

		emit(false, false, "")
		doneCh := make(chan struct{})
		go func() {
			ticker := time.NewTicker(time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-doneCh:
					return
				case <-ticker.C:
					emit(false, false, "")
				}
			}
		}()
		defer close(doneCh)

		type dirJob struct {
			remote string
			local  string
		}
		stack := []dirJob{{remote: remotePath, local: localRoot}}

		for len(stack) > 0 {
			select {
			case <-ctx.Done():
				emit(true, true, "")
				return
			default:
			}

			job := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if err := os.MkdirAll(job.local, 0o755); err != nil {
				emit(true, false, err.Error())
				return
			}

			entries, err := client.ReadDir(job.remote)
			if err != nil {
				emit(true, false, fmt.Sprintf("list %s: %v", job.remote, err))
				return
			}
			maybeEmit()
			for _, entry := range entries {
				select {
				case <-ctx.Done():
					emit(true, true, "")
					return
				default:
				}

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
				if err := downloadRemoteFile(ctx, client, remoteChild, localChild, func(n int64) {
					addDone(n)
					maybeEmit()
				}); err != nil {
					if ctx.Err() != nil {
						emit(true, true, "")
						return
					}
					emit(true, false, fmt.Sprintf("download %s: %v", remoteChild, err))
					return
				}
				maybeEmit()
			}
		}

		emit(true, false, "")
	}()

	return nil
}

func downloadRemoteFile(ctx context.Context, client *sftp.Client, remotePath, localPath string, onBytes func(int64)) error {
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

	_, err = src.WriteTo(&ctxWriter{ctx: ctx, w: dst, onBytes: onBytes})
	return err
}

func emitProgress(ctx context.Context, onProgress ProgressHandler, id, name, action string, done, total int64, speed float64, finished, cancelled bool, errMsg string) {
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
		Cancelled:  cancelled,
		ErrMsg:     errMsg,
	}
	if onProgress != nil {
		onProgress(progress)
		return
	}
	runtime.EventsEmit(ctx, "sftp:progress", progress)
}
