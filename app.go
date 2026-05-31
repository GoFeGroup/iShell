package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"ishell/backend/local"
	"ishell/backend/ssh"
	"ishell/backend/storage"
)

// App is the central struct bound to the Wails frontend.
type App struct {
	ctx      context.Context
	store    *storage.Store
	sshMgr   *ssh.Manager
	localMgr *local.Manager
	dataDir  string
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	installEscGuard()
	a.dataDir = dataDir()
	store, err := storage.Open(a.dataDir)
	if err != nil {
		wailsRuntime.LogErrorf(ctx, "open store: %v", err)
		// Continue without persistence rather than crash
	}
	a.store = store
	a.sshMgr = ssh.NewManager(ctx)
	a.localMgr = local.NewManager(ctx)
}

func (a *App) shutdown(_ context.Context) {
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

	connID, err := a.sshMgr.Connect(ssh.ConnectOptions{
		Session:        *sess,
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

// AcceptHostKey writes the pending host key for hostname to known_hosts.
func (a *App) AcceptHostKey(hostname string) error {
	settings, _ := a.store.LoadSettings()
	khPath := ""
	if settings != nil {
		khPath = settings.KnownHostsPath
	}
	return a.sshMgr.AcceptAndStoreHostKey(hostname, khPath)
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
		id, err := ssh.UploadFile(a.ctx, cl, lp, rp)
		if err != nil {
			wailsRuntime.LogErrorf(a.ctx, "upload %s: %v", lp, err)
		}
		ids = append(ids, id)
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
		id, err := ssh.UploadFile(a.ctx, cl, lp, rp)
		if err != nil {
			wailsRuntime.LogErrorf(a.ctx, "upload %s: %v", lp, err)
		}
		ids = append(ids, id)
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
		id, err := ssh.DownloadFile(a.ctx, cl, rp, localDir)
		if err != nil {
			wailsRuntime.LogErrorf(a.ctx, "download %s: %v", rp, err)
		}
		ids = append(ids, id)
	}
	return ids, nil
}

// ── Local filesystem ──────────────────────────────────────────────────────────

func (a *App) ListLocalDir(path string) ([]ssh.FileInfo, error) {
	return ssh.ListLocalDir(path)
}

func (a *App) GetHomeDir() string {
	home, _ := os.UserHomeDir()
	return home
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
	return a.store.SaveSettings(settings)
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
