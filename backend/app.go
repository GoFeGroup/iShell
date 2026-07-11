package backend

import (
	"context"
	"encoding/base64"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"ishell/backend/ai"
	"ishell/backend/local"
	"ishell/backend/osutil"
	"ishell/backend/ssh"
	"ishell/backend/storage"
)

// App is the central struct bound to the Wails frontend.
type App struct {
	ctx       context.Context
	store     *storage.Store
	sshMgr    *ssh.Manager
	localMgr  *local.Manager
	aiAgent   *ai.Agent
	dataDir   string
	transfers map[string]TransferRecord
	cancels   map[string]context.CancelFunc
	txMu      sync.RWMutex
}

type TransferRecord struct {
	TransferID string  `json:"transfer_id"`
	ConnID     string  `json:"conn_id"`
	Name       string  `json:"name"`
	Action     string  `json:"action"`
	RemotePath string  `json:"remote_path,omitempty"`
	LocalPath  string  `json:"local_path,omitempty"`
	Total      int64   `json:"total"`
	Done       int64   `json:"done"`
	Percent    float64 `json:"percent"`
	Speed      float64 `json:"speed_bps"`
	Finished   bool    `json:"finished"`
	Cancelled  bool    `json:"cancelled,omitempty"`
	ErrMsg     string  `json:"error,omitempty"`
	StartedAt  string  `json:"started_at"`
	UpdatedAt  string  `json:"updated_at"`
}

func NewApp() *App {
	return &App{}
}

func (a *App) GetVersion() string {
	return Version
}

func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
	osutil.InstallEscGuard()
	a.dataDir = dataDir()
	store, err := storage.Open(a.dataDir)
	if err != nil {
		wailsRuntime.LogErrorf(ctx, "open store: %v", err)
		// Continue without persistence rather than crash
	}
	a.store = store
	a.sshMgr = ssh.NewManager(ctx, store)
	a.localMgr = local.NewManager(ctx)
	a.aiAgent = ai.NewAgent(a.store, a, func(event string, payload any) {
		wailsRuntime.EventsEmit(a.ctx, event, payload)
	})
	a.transfers = make(map[string]TransferRecord)
	a.cancels = make(map[string]context.CancelFunc)
}

// FocusWindow brings the app window to the foreground and ensures it has
// keyboard focus. Called from JS on page load to handle cases where the OS
// does not automatically activate the window (e.g. launched from a terminal).
func (a *App) FocusWindow() {
	osutil.PlatformBringToFront()
}

// LaunchNewInstance starts a separate iShell process. On macOS, LaunchServices
// needs `open -n` for a second instance of the same .app bundle.
func (a *App) LaunchNewInstance() error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve executable: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}

	if runtime.GOOS == "darwin" {
		if bundle := appBundlePath(exe); bundle != "" {
			if output, err := exec.Command("open", "-n", bundle).CombinedOutput(); err != nil {
				msg := strings.TrimSpace(string(output))
				if msg != "" {
					return fmt.Errorf("open new instance: %w: %s", err, msg)
				}
				return fmt.Errorf("open new instance: %w", err)
			}
			return nil
		}
	}

	cmd := exec.Command(exe)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start new instance: %w", err)
	}
	return cmd.Process.Release()
}

func appBundlePath(exe string) string {
	for dir := filepath.Dir(exe); dir != "." && dir != string(filepath.Separator); dir = filepath.Dir(dir) {
		if strings.HasSuffix(dir, ".app") {
			return dir
		}
	}
	return ""
}

func (a *App) Shutdown(_ context.Context) {
	a.sshMgr.CloseAll()
	a.localMgr.CloseAll()
	if a.store != nil {
		_ = a.store.Close()
	}
}

func dataDir() string {
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		if d := os.Getenv("APPDATA"); d != "" {
			return filepath.Join(d, "iShell")
		}
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "iShell")
	}
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" {
		return filepath.Join(d, "ishell")
	}
	return filepath.Join(home, ".config", "ishell")
}

// ── Sessions ──────────────────────────────────────────────────────────────────

func (a *App) GetSessions() ([]storage.Session, error) {
	if a.store == nil {
		return nil, nil
	}
	return a.store.ListSessions()
}

func (a *App) GetSession(id string) (*storage.Session, error) {
	if a.store == nil {
		return nil, fmt.Errorf("store not ready")
	}
	return a.store.GetSession(id)
}

func (a *App) SaveSession(sess storage.Session) (*storage.Session, error) {
	if a.store == nil {
		return nil, fmt.Errorf("store not ready")
	}
	return a.store.SaveSession(sess)
}

func (a *App) DeleteSession(id string) error {
	if a.store == nil {
		return fmt.Errorf("store not ready")
	}
	return a.store.DeleteSession(id)
}

// ── SSH connection ────────────────────────────────────────────────────────────

type ConnectRequest struct {
	SessionID        string `json:"session_id"`
	Password         string `json:"password"`
	KeyPath          string `json:"key_path"`
	Passphrase       string `json:"passphrase"`
	Cols             int    `json:"cols"`
	Rows             int    `json:"rows"`
	SkipHostKeyCheck bool   `json:"skip_host_key_check"`
}

func (a *App) Connect(req ConnectRequest) (string, error) {
	if a.store == nil {
		return "", fmt.Errorf("store not ready")
	}
	sess, err := a.store.GetSession(req.SessionID)
	if err != nil || sess == nil {
		return "", fmt.Errorf("session not found: %s", req.SessionID)
	}

	settings, _ := a.store.LoadSettings()
	khPath := ""
	strictHK := true
	if settings != nil {
		khPath = settings.KnownHostsPath
		strictHK = settings.StrictHostKey
	}
	if req.SkipHostKeyCheck {
		strictHK = false
	}

	var jumpSess *storage.Session
	if sess.JumpProfileID != "" {
		jumpSess, _ = a.store.GetSession(sess.JumpProfileID)
	}

	connID, err := a.sshMgr.Connect(ssh.ConnectOptions{
		Session:        *sess,
		JumpSession:    jumpSess,
		Password:       req.Password,
		KeyPath:        req.KeyPath,
		Passphrase:     req.Passphrase,
		KnownHostsPath: khPath,
		StrictHostKey:  strictHK,
		Cols:           req.Cols,
		Rows:           req.Rows,
	})
	return connID, err
}

func (a *App) ConnectLocal(cols, rows int) (string, error) {
	return a.localMgr.Connect(cols, rows)
}

func (a *App) Disconnect(connID string) error {
	if a.localMgr.Has(connID) {
		return a.localMgr.Disconnect(connID)
	}
	return a.sshMgr.Disconnect(connID)
}

func (a *App) GetActiveConnections() map[string]string {
	return a.sshMgr.ListActive()
}

func (a *App) SendInput(connID, data string) error {
	if a.localMgr.Has(connID) {
		return a.localMgr.SendInput(connID, []byte(data))
	}
	return a.sshMgr.SendInput(connID, []byte(data))
}

func (a *App) ResizeTerminal(connID string, cols, rows int) error {
	if a.localMgr.Has(connID) {
		return a.localMgr.ResizeTerminal(connID, cols, rows)
	}
	return a.sshMgr.ResizeTerminal(connID, cols, rows)
}

// Snapshot and Since implement ai.TerminalIO, letting the AI agent read
// recent raw terminal output when executing terminal_run/terminal_read tool
// calls. Dispatch mirrors SendInput/ResizeTerminal above.
func (a *App) Snapshot(connID string) ([]byte, int64, error) {
	if a.localMgr.Has(connID) {
		return a.localMgr.Snapshot(connID)
	}
	return a.sshMgr.Snapshot(connID)
}

func (a *App) Since(connID string, offset int64) ([]byte, error) {
	if a.localMgr.Has(connID) {
		return a.localMgr.Since(connID, offset)
	}
	return a.sshMgr.Since(connID, offset)
}

// AcceptHostKey writes the pending host key for hostname to known_hosts.
func (a *App) AcceptHostKey(hostname string) error {
	settings, _ := a.store.LoadSettings()
	khPath := ""
	if settings != nil {
		khPath = settings.KnownHostsPath
	}
	return a.sshMgr.AcceptAndStoreHostKey(hostname, khPath)
}

// CheckAgentAvailable reports whether a running SSH agent (ssh-agent via
// SSH_AUTH_SOCK, or Pageant on Windows) can currently be reached, so the
// profile form can show a live status instead of static text.
func (a *App) CheckAgentAvailable() bool {
	_, closer, err := ssh.DialAgent()
	if closer != nil {
		closer.Close()
	}
	return err == nil
}

// ── Port forwarding ──────────────────────────────────────────────────────────

func (a *App) ListPortForwardsForSession(sessionID string) ([]storage.PortForward, error) {
	if a.store == nil {
		return nil, fmt.Errorf("store not ready")
	}
	return a.store.ListPortForwardsForSession(sessionID)
}

func (a *App) SavePortForward(pf storage.PortForward) (*storage.PortForward, error) {
	if a.store == nil {
		return nil, fmt.Errorf("store not ready")
	}
	return a.store.SavePortForward(pf)
}

func (a *App) DeletePortForward(id string) error {
	if a.store == nil {
		return fmt.Errorf("store not ready")
	}
	return a.store.DeletePortForward(id)
}

// StartPortForward starts a previously saved rule against a live connection.
func (a *App) StartPortForward(connID, forwardID string) (string, error) {
	if a.store == nil {
		return "", fmt.Errorf("store not ready")
	}
	rule, err := a.store.GetPortForward(forwardID)
	if err != nil {
		return "", err
	}
	if rule == nil {
		return "", fmt.Errorf("port forward %s not found", forwardID)
	}
	return a.sshMgr.StartForward(connID, *rule)
}

// StartAdHocForward starts a tunnel that is never persisted to storage.
func (a *App) StartAdHocForward(connID string, pf storage.PortForward) (string, error) {
	pf.SessionID = ""
	return a.sshMgr.StartForward(connID, pf)
}

func (a *App) StopPortForward(connID, forwardID string) error {
	return a.sshMgr.StopForward(connID, forwardID)
}

func (a *App) ListActiveForwards(connID string) ([]ssh.ForwardStatus, error) {
	return a.sshMgr.ListForwards(connID), nil
}

// ── SFTP ─────────────────────────────────────────────────────────────────────

func (a *App) ListRemoteDir(connID, path string) ([]ssh.FileInfo, error) {
	cl, err := a.sshMgr.SFTPClient(connID)
	if err != nil {
		return nil, err
	}
	return ssh.ListRemoteDir(cl, path)
}

func (a *App) MakeRemoteDir(connID, path string) error {
	cl, err := a.sshMgr.SFTPClient(connID)
	if err != nil {
		return err
	}
	return ssh.MakeRemoteDir(cl, path)
}

func (a *App) DeleteRemote(connID, path string) error {
	cl, err := a.sshMgr.SFTPClient(connID)
	if err != nil {
		return err
	}
	return ssh.DeleteRemote(cl, path)
}

func (a *App) RenameRemote(connID, oldPath, newPath string) error {
	cl, err := a.sshMgr.SFTPClient(connID)
	if err != nil {
		return err
	}
	return ssh.RenameRemote(cl, oldPath, newPath)
}

func (a *App) SetRemotePermissions(connID, path string, mode uint32) error {
	cl, err := a.sshMgr.SFTPClient(connID)
	if err != nil {
		return err
	}
	return ssh.SetRemotePermissions(cl, path, os.FileMode(mode))
}

// newCancellableTransfer generates a transfer ID up front and registers a
// cancel function for it, so CancelSFTPTransfer can stop the goroutine before
// it even starts (the caller passes the returned ctx into the ssh package
// transfer function).
func (a *App) newCancellableTransfer() (string, context.Context) {
	transferID := uuid.NewString()
	ctx, cancel := context.WithCancel(a.ctx)
	a.txMu.Lock()
	a.cancels[transferID] = cancel
	a.txMu.Unlock()
	return transferID, ctx
}

// CancelSFTPTransfer stops an in-flight upload/download. It is a no-op error
// if the transfer has already finished or never existed.
func (a *App) CancelSFTPTransfer(transferID string) error {
	a.txMu.Lock()
	cancel, ok := a.cancels[transferID]
	a.txMu.Unlock()
	if !ok {
		return fmt.Errorf("transfer not found or already finished: %s", transferID)
	}
	cancel()
	return nil
}

// UploadFiles opens a file dialog, then uploads selected files to remotePath.
func (a *App) UploadFiles(connID, remotePath string) ([]string, error) {
	localPaths, err := wailsRuntime.OpenMultipleFilesDialog(a.ctx, wailsRuntime.OpenDialogOptions{
		Title: "Select files to upload",
	})
	if err != nil || len(localPaths) == 0 {
		return nil, err
	}
	cl, err := a.sshMgr.SFTPClient(connID)
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, lp := range localPaths {
		name := filepath.Base(lp)
		rp := remotePath + "/" + name
		transferID, ctx := a.newCancellableTransfer()
		if err := ssh.UploadFileWithProgress(ctx, transferID, cl, lp, rp, a.transferProgressHandler(connID, "upload", rp, lp)); err != nil {
			wailsRuntime.LogErrorf(a.ctx, "upload %s: %v", lp, err)
		}
		ids = append(ids, transferID)
	}
	return ids, nil
}

// UploadSpecificFiles uploads a pre-selected list of local paths.
func (a *App) UploadSpecificFiles(connID string, localPaths []string, remotePath string) ([]string, error) {
	cl, err := a.sshMgr.SFTPClient(connID)
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, lp := range localPaths {
		name := filepath.Base(lp)
		rp := remotePath + "/" + name
		transferID, ctx := a.newCancellableTransfer()
		if err := ssh.UploadFileWithProgress(ctx, transferID, cl, lp, rp, a.transferProgressHandler(connID, "upload", rp, lp)); err != nil {
			wailsRuntime.LogErrorf(a.ctx, "upload %s: %v", lp, err)
		}
		ids = append(ids, transferID)
	}
	return ids, nil
}

// DownloadFiles opens a directory dialog then downloads remotePaths to it.
func (a *App) DownloadFiles(connID string, remotePaths []string) ([]string, error) {
	localDir, err := wailsRuntime.OpenDirectoryDialog(a.ctx, wailsRuntime.OpenDialogOptions{
		Title: "Choose download destination",
	})
	if err != nil || localDir == "" {
		return nil, err
	}
	return a.DownloadFilesToDir(connID, remotePaths, localDir)
}

// DownloadFilesToDir downloads remotePaths into the specified localDir without a dialog.
func (a *App) DownloadFilesToDir(connID string, remotePaths []string, localDir string) ([]string, error) {
	cl, err := a.sshMgr.SFTPClient(connID)
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, rp := range remotePaths {
		localPath := filepath.Join(localDir, filepath.Base(rp))
		transferID, ctx := a.newCancellableTransfer()
		if err := ssh.DownloadPathWithProgress(ctx, transferID, cl, rp, localDir, a.transferProgressHandler(connID, "download", rp, localPath)); err != nil {
			wailsRuntime.LogErrorf(a.ctx, "download %s: %v", rp, err)
		}
		ids = append(ids, transferID)
	}
	return ids, nil
}

func (a *App) GetSFTPTransfers(connID string) []TransferRecord {
	a.txMu.RLock()
	defer a.txMu.RUnlock()

	records := make([]TransferRecord, 0, len(a.transfers))
	for _, rec := range a.transfers {
		if connID == "" || rec.ConnID == connID {
			records = append(records, rec)
		}
	}
	return records
}

func (a *App) ClearFinishedSFTPTransfers(connID string) int {
	a.txMu.Lock()
	defer a.txMu.Unlock()

	cleared := 0
	for id, rec := range a.transfers {
		if rec.Finished && (connID == "" || rec.ConnID == connID) {
			delete(a.transfers, id)
			cleared++
		}
	}
	return cleared
}

func (a *App) transferProgressHandler(connID, action, remotePath, localPath string) ssh.ProgressHandler {
	startedAt := time.Now().UTC().Format(time.RFC3339)
	return func(progress ssh.TransferProgress) {
		a.txMu.Lock()

		rec, ok := a.transfers[progress.TransferID]
		if !ok {
			rec = TransferRecord{
				TransferID: progress.TransferID,
				ConnID:     connID,
				Action:     action,
				RemotePath: remotePath,
				LocalPath:  localPath,
				StartedAt:  startedAt,
			}
		}
		rec.Name = progress.Name
		rec.Total = progress.Total
		rec.Done = progress.Done
		rec.Percent = progress.Percent
		rec.Speed = progress.Speed
		rec.Finished = progress.Finished
		rec.Cancelled = progress.Cancelled
		rec.ErrMsg = progress.ErrMsg
		rec.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		if progress.Action != "" {
			rec.Action = progress.Action
		}
		a.transfers[progress.TransferID] = rec
		if progress.Finished {
			delete(a.cancels, progress.TransferID)
		}
		a.txMu.Unlock()

		wailsRuntime.EventsEmit(a.ctx, "sftp:progress", rec)
	}
}

// ── Local filesystem ──────────────────────────────────────────────────────────

func (a *App) ListLocalDir(path string) ([]ssh.FileInfo, error) {
	return ssh.ListLocalDir(path)
}

func (a *App) GetHomeDir() string {
	home, _ := os.UserHomeDir()
	return home
}

func (a *App) GetDownloadsDir() string {
	home, _ := os.UserHomeDir()
	dl := filepath.Join(home, "Downloads")
	if _, err := os.Stat(dl); err == nil {
		return dl
	}
	return home
}

func (a *App) GetRemotePWD(connID string) (string, error) {
	return a.sshMgr.RemotePWD(connID)
}

// ── Settings ──────────────────────────────────────────────────────────────────

func (a *App) GetSettings() (*storage.Settings, error) {
	if a.store == nil {
		def := storage.DefaultSettings()
		return &def, nil
	}
	return a.store.LoadSettings()
}

func (a *App) SaveSettings(settings storage.Settings) error {
	if a.store == nil {
		return fmt.Errorf("store not ready")
	}
	if err := ai.ValidateCustomToolCalls(settings.CustomToolCalls); err != nil {
		return err
	}
	if err := ai.ValidateAIProviders(settings.AIProviders); err != nil {
		return err
	}
	return a.store.SaveSettings(settings)
}

// ListBuiltinToolCalls returns the read-only listing of built-in AI tools
// shown in the settings page, alongside the user's custom tool calls.
func (a *App) ListBuiltinToolCalls() []ai.BuiltinToolInfo {
	return ai.BuiltinToolInfos()
}

// ── Known hosts ───────────────────────────────────────────────────────────────

func (a *App) GetKnownHosts() ([]ssh.KnownHostEntry, error) {
	settings, _ := a.store.LoadSettings()
	khPath := ""
	if settings != nil {
		khPath = settings.KnownHostsPath
	}
	return ssh.ListKnownHosts(khPath)
}

func (a *App) RemoveKnownHost(hostname string) error {
	settings, _ := a.store.LoadSettings()
	khPath := ""
	if settings != nil {
		khPath = settings.KnownHostsPath
	}
	return ssh.RemoveKnownHost(khPath, hostname)
}

// ── Key validation ────────────────────────────────────────────────────────────

func (a *App) ValidateKey(path, passphrase string) (bool, error) {
	return ssh.ValidateKey(path, passphrase)
}

// OpenKeyFileDialog opens a file picker for SSH private keys.
func (a *App) OpenKeyFileDialog() (string, error) {
	home, _ := os.UserHomeDir()
	path, err := wailsRuntime.OpenFileDialog(a.ctx, wailsRuntime.OpenDialogOptions{
		Title:            "Select SSH Private Key",
		DefaultDirectory: filepath.Join(home, ".ssh"),
	})
	return path, err
}

// ── Zmodem ────────────────────────────────────────────────────────────────────

// SendInputBytes sends raw binary data (base64-encoded) to the terminal session.
// Used by the Zmodem protocol handler in the frontend.
func (a *App) SendInputBytes(connID, b64data string) error {
	data, err := base64.StdEncoding.DecodeString(b64data)
	if err != nil {
		return fmt.Errorf("base64 decode: %w", err)
	}
	if a.localMgr.Has(connID) {
		return a.localMgr.SendInput(connID, data)
	}
	return a.sshMgr.SendInput(connID, data)
}

// ZmodemFile holds file metadata and base64-encoded content for Zmodem transfer.
type ZmodemFile struct {
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	Content string `json:"content"` // base64-encoded
}

// OpenFilesForZmodem opens a file-picker dialog and returns the selected files
// with their contents base64-encoded, for use with the rz (receive) Zmodem command.
func (a *App) OpenFilesForZmodem() ([]ZmodemFile, error) {
	paths, err := wailsRuntime.OpenMultipleFilesDialog(a.ctx, wailsRuntime.OpenDialogOptions{
		Title: "Select files to send (rz)",
	})
	if err != nil || len(paths) == 0 {
		return nil, err
	}
	var files []ZmodemFile
	for _, p := range paths {
		info, err := os.Stat(p)
		if err != nil {
			continue
		}
		content, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		files = append(files, ZmodemFile{
			Name:    filepath.Base(p),
			Size:    info.Size(),
			Content: base64.StdEncoding.EncodeToString(content),
		})
	}
	return files, nil
}

// SaveZmodemFile saves a file received via Zmodem (sz) to the downloads directory.
// Returns the full path of the saved file.
func (a *App) SaveZmodemFile(filename, b64data string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(b64data)
	if err != nil {
		return "", fmt.Errorf("base64 decode: %w", err)
	}
	dir := a.GetDownloadsDir()
	base := filepath.Base(filepath.FromSlash(filename))
	destPath := filepath.Join(dir, base)
	// Avoid overwriting existing files by appending _N.
	if _, err := os.Stat(destPath); err == nil {
		ext := filepath.Ext(base)
		stem := strings.TrimSuffix(base, ext)
		for i := 1; i <= 999; i++ {
			candidate := filepath.Join(dir, fmt.Sprintf("%s_%d%s", stem, i, ext))
			if _, statErr := os.Stat(candidate); os.IsNotExist(statErr) {
				destPath = candidate
				break
			}
		}
	}
	if err := os.WriteFile(destPath, data, 0644); err != nil {
		return "", fmt.Errorf("write file: %w", err)
	}
	return destPath, nil
}

// ── Config import/export ─────────────────────────────────────────────────────

// ExportConfig opens a native "Save As" dialog and writes every session and
// the app settings to a YAML file. Returns the saved path, or "" if the user
// cancelled the dialog.
func (a *App) ExportConfig() (string, error) {
	if a.store == nil {
		return "", fmt.Errorf("store not ready")
	}
	data, err := a.store.ExportAll()
	if err != nil {
		return "", fmt.Errorf("export config: %w", err)
	}

	path, err := wailsRuntime.SaveFileDialog(a.ctx, wailsRuntime.SaveDialogOptions{
		Title:           "Export iShell Config",
		DefaultFilename: fmt.Sprintf("ishell-config-%s.yaml", time.Now().Format("20060102-150405")),
		Filters: []wailsRuntime.FileFilter{
			{DisplayName: "YAML (*.yaml)", Pattern: "*.yaml;*.yml"},
		},
	})
	if err != nil || path == "" {
		return "", err
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		return "", fmt.Errorf("write file: %w", err)
	}
	return path, nil
}

// ImportConfig opens a native "Open" dialog, parses the selected YAML file,
// and upserts its sessions plus settings into the store. Returns nil result
// if the user cancelled the dialog.
func (a *App) ImportConfig() (*storage.ImportResult, error) {
	if a.store == nil {
		return nil, fmt.Errorf("store not ready")
	}
	path, err := wailsRuntime.OpenFileDialog(a.ctx, wailsRuntime.OpenDialogOptions{
		Title: "Import iShell Config",
		Filters: []wailsRuntime.FileFilter{
			{DisplayName: "YAML (*.yaml)", Pattern: "*.yaml;*.yml"},
		},
	})
	if err != nil || path == "" {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read file: %w", err)
	}
	return a.store.ImportAll(data)
}

// ── AI chat ───────────────────────────────────────────────────────────────────

// ListAIChatSessionsForTarget returns the chat sessions bound to targetID —
// an SSH Session.ID, or "__local__" for any local terminal — so each
// terminal only ever sees its own AI conversations.
func (a *App) ListAIChatSessionsForTarget(targetID string) ([]storage.AIChatSession, error) {
	if a.store == nil {
		return nil, fmt.Errorf("store not ready")
	}
	return a.store.ListAIChatSessionsByTarget(targetID)
}

func (a *App) CreateAIChatSession(targetID, title string) (*storage.AIChatSession, error) {
	if a.store == nil {
		return nil, fmt.Errorf("store not ready")
	}
	return a.store.SaveAIChatSession(storage.AIChatSession{TargetID: targetID, Title: title})
}

func (a *App) RenameAIChatSession(id, title string) error {
	if a.store == nil {
		return fmt.Errorf("store not ready")
	}
	sess, err := a.store.GetAIChatSession(id)
	if err != nil {
		return err
	}
	if sess == nil {
		return fmt.Errorf("chat session %s not found", id)
	}
	sess.Title = title
	_, err = a.store.SaveAIChatSession(*sess)
	return err
}

// SetAIChatProvider records which configured AI provider a chat session
// should use for subsequent turns; providerID "" reverts it to the default
// (first configured) provider.
func (a *App) SetAIChatProvider(chatID, providerID string) error {
	if a.store == nil {
		return fmt.Errorf("store not ready")
	}
	sess, err := a.store.GetAIChatSession(chatID)
	if err != nil {
		return err
	}
	if sess == nil {
		return fmt.Errorf("chat session %s not found", chatID)
	}
	return a.store.SetAIChatProvider(chatID, providerID)
}

func (a *App) DeleteAIChatSession(id string) error {
	if a.store == nil {
		return fmt.Errorf("store not ready")
	}
	return a.store.DeleteAIChatSession(id)
}

func (a *App) GetAIChatMessages(sessionID string) ([]storage.AIChatMessage, error) {
	if a.store == nil {
		return nil, fmt.Errorf("store not ready")
	}
	sess, err := a.store.GetAIChatSession(sessionID)
	if err != nil {
		return nil, err
	}
	if sess == nil {
		return nil, fmt.Errorf("chat session %s not found", sessionID)
	}
	return a.store.ListAIChatMessages(sessionID)
}

// SendAIMessage kicks off the agent's tool-calling loop in the background
// and returns immediately; the model's reply (and any tool-call activity)
// arrives via "ai:*:<chatID>" events. connID is whichever terminal tab the
// frontend currently has active, resolved at send-time — "" if none.
func (a *App) SendAIMessage(chatID, connID, text string, contexts []storage.AIMessageContext) error {
	if a.store == nil || a.aiAgent == nil {
		return fmt.Errorf("AI is not ready")
	}
	settings, err := a.store.LoadSettings()
	if err != nil {
		return fmt.Errorf("load settings: %w", err)
	}
	if !settings.AIEnabled {
		return fmt.Errorf("AI is not enabled in settings")
	}
	sess, err := a.store.GetAIChatSession(chatID)
	if err != nil {
		return err
	}
	if sess == nil {
		return fmt.Errorf("chat session %s not found", chatID)
	}
	messages, err := a.store.ListAIChatMessages(chatID)
	if err != nil {
		return fmt.Errorf("list chat messages: %w", err)
	}
	if len(messages) == 0 {
		go func() {
			titleCtx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
			defer cancel()
			if err := a.aiAgent.GenerateChatTitle(titleCtx, chatID, text); err != nil {
				log.Printf("ai: generate title for chat %s: %v", chatID, err)
			}
		}()
	}
	contexts = sanitizeAIContexts(contexts)
	go a.aiAgent.RunTurn(a.ctx, ai.RunOptions{ChatID: chatID, ConnID: connID, UserText: text, Contexts: contexts})
	return nil
}

// RetryAIMessage resumes a failed generation from its persisted history. It
// deliberately does not append another user message, so retrying a provider
// or network failure cannot duplicate the prompt in subsequent model input.
func (a *App) RetryAIMessage(chatID, connID string) error {
	if a.store == nil || a.aiAgent == nil {
		return fmt.Errorf("AI is not ready")
	}
	settings, err := a.store.LoadSettings()
	if err != nil {
		return fmt.Errorf("load settings: %w", err)
	}
	if !settings.AIEnabled {
		return fmt.Errorf("AI is not enabled in settings")
	}
	sess, err := a.store.GetAIChatSession(chatID)
	if err != nil {
		return err
	}
	if sess == nil {
		return fmt.Errorf("chat session %s not found", chatID)
	}
	if a.aiAgent.IsRunning(chatID) {
		return fmt.Errorf("a generation is already running for this chat")
	}
	if err := a.aiAgent.ValidateResumeTurn(chatID); err != nil {
		return err
	}
	go a.aiAgent.RunTurn(a.ctx, ai.RunOptions{ChatID: chatID, ConnID: connID, Resume: true})
	return nil
}

// GenerateCommandSuggestion returns a single suggested shell command for a
// natural-language prompt, used by the inline command bar. Unlike
// SendAIMessage this is synchronous (one short completion, no tools, nothing
// persisted) so the frontend can simply await the result.
func (a *App) GenerateCommandSuggestion(connID, prompt string) (string, error) {
	if a.store == nil || a.aiAgent == nil {
		return "", fmt.Errorf("AI is not ready")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 20*time.Second)
	defer cancel()
	return a.aiAgent.GenerateCommandSuggestion(ctx, connID, prompt)
}

// TestAIProvider verifies that a model service's Base URL/API Key/Model are
// valid by issuing one real completion request against them. It checks the
// values passed in directly, so the settings UI can test a provider before
// saving it.
func (a *App) TestAIProvider(provider storage.AIProvider) error {
	if a.aiAgent == nil {
		return fmt.Errorf("AI is not ready")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 15*time.Second)
	defer cancel()
	return a.aiAgent.TestProvider(ctx, provider)
}

const maxAIContextBytes = 64 * 1024

func sanitizeAIContexts(contexts []storage.AIMessageContext) []storage.AIMessageContext {
	if len(contexts) > 8 {
		contexts = contexts[:8]
	}
	result := make([]storage.AIMessageContext, 0, len(contexts))
	for _, item := range contexts {
		item.Kind = strings.TrimSpace(item.Kind)
		item.Label = strings.TrimSpace(item.Label)
		if item.Kind == "" || item.Content == "" {
			continue
		}
		labelRunes := []rune(item.Label)
		if len(labelRunes) > 160 {
			item.Label = string(labelRunes[:160])
		}
		if len(item.Content) > maxAIContextBytes {
			item.Content = item.Content[:maxAIContextBytes]
			for !utf8.ValidString(item.Content) {
				item.Content = item.Content[:len(item.Content)-1]
			}
			item.Truncated = true
		}
		result = append(result, item)
	}
	return result
}

func (a *App) ApproveAIToolCall(pendingID string) error {
	if a.aiAgent == nil {
		return fmt.Errorf("AI is not ready")
	}
	return a.aiAgent.ApproveToolCall(pendingID)
}

func (a *App) RejectAIToolCall(pendingID string) error {
	if a.aiAgent == nil {
		return fmt.Errorf("AI is not ready")
	}
	return a.aiAgent.RejectToolCall(pendingID)
}

func (a *App) SetAIAutoExec(chatID string, on bool) error {
	if a.aiAgent == nil {
		return fmt.Errorf("AI is not ready")
	}
	return a.aiAgent.SetAutoExec(chatID, on)
}

func (a *App) StopAIRun(chatID string) error {
	if a.aiAgent == nil {
		return fmt.Errorf("AI is not ready")
	}
	a.aiAgent.StopRun(chatID)
	return nil
}

// IsAIRunActive reports whether chatID currently has a generation in flight,
// so the frontend can correctly show/hide the stop button after switching
// terminal tabs away from and back to a chat (events emitted while the tab
// was inactive are missed since chat events are only subscribed while active).
func (a *App) IsAIRunActive(chatID string) bool {
	if a.aiAgent == nil {
		return false
	}
	return a.aiAgent.IsRunning(chatID)
}
