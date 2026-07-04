/**
 * api.js — typed wrappers around window.go.backend.App.*
 * All methods return Promises.
 */

const go = () => window.go.backend?.App || window.go.main.App;

export const getSessions    = ()      => go().GetSessions();
export const getSession     = (id)    => go().GetSession(id);
export const saveSession    = (sess)  => go().SaveSession(sess);
export const deleteSession  = (id)    => go().DeleteSession(id);
export const getVersion     = ()      => go().GetVersion();
export const focusWindow    = ()      => go().FocusWindow();
export const launchNewInstance = ()   => go().LaunchNewInstance();

export const connect        = (req)   => go().Connect(req);
export const connectLocal   = (c, r)  => go().ConnectLocal(c, r);
export const disconnect     = (id)    => go().Disconnect(id);
export const getActiveConns = ()      => go().GetActiveConnections();
export const sendInput      = (id, d) => go().SendInput(id, d);
export const resizeTerm     = (id, c, r) => go().ResizeTerminal(id, c, r);

export const listRemoteDir  = (id, p) => go().ListRemoteDir(id, p);
export const makeRemoteDir  = (id, p) => go().MakeRemoteDir(id, p);
export const deleteRemote   = (id, p) => go().DeleteRemote(id, p);
export const renameRemote   = (id, o, n) => go().RenameRemote(id, o, n);
export const setPermissions = (id, p, m) => go().SetRemotePermissions(id, p, m);
export const uploadFiles    = (id, rp)   => go().UploadFiles(id, rp);
export const uploadSpecific = (id, lps, rp) => go().UploadSpecificFiles(id, lps, rp);
export const downloadFiles      = (id, rps)        => go().DownloadFiles(id, rps);
export const downloadFilesToDir = (id, rps, dir)   => go().DownloadFilesToDir(id, rps, dir);
export const getSFTPTransfers   = (id)             => go().GetSFTPTransfers(id);
export const clearFinishedSFTPTransfers = (id)     => go().ClearFinishedSFTPTransfers(id);
export const cancelSFTPTransfer = (transferID)     => go().CancelSFTPTransfer(transferID);

export const listLocalDir   = (p)     => go().ListLocalDir(p);
export const getHomeDir     = ()      => go().GetHomeDir();
export const getDownloadsDir = ()     => go().GetDownloadsDir();
export const getRemotePWD   = (id)    => go().GetRemotePWD(id);

export const getSettings    = ()      => go().GetSettings();
export const saveSettings   = (s)     => go().SaveSettings(s);
export const listBuiltinToolCalls = () => go().ListBuiltinToolCalls();

export const getKnownHosts  = ()      => go().GetKnownHosts();
export const acceptHostKey  = (h)     => go().AcceptHostKey(h);
export const removeKnownHost= (h)     => go().RemoveKnownHost(h);
export const validateKey    = (p, pp) => go().ValidateKey(p, pp);
export const openKeyDialog  = ()      => go().OpenKeyFileDialog();

export const exportConfig   = ()      => go().ExportConfig();
export const importConfig   = ()      => go().ImportConfig();

export const sendInputBytes     = (id, b64)        => go().SendInputBytes(id, b64);
export const openFilesForZmodem = ()               => go().OpenFilesForZmodem();
export const saveZmodemFile     = (name, b64)      => go().SaveZmodemFile(name, b64);

// ── AI ────────────────────────────────────────────────────────────────────────
export const listAIChatSessionsForTarget = (targetID)  => go().ListAIChatSessionsForTarget(targetID);
export const createAIChatSession = (targetID, title)   => go().CreateAIChatSession(targetID, title);
export const renameAIChatSession = (id, title)         => go().RenameAIChatSession(id, title);
export const deleteAIChatSession = (id)                => go().DeleteAIChatSession(id);
export const getAIChatMessages   = (sessionID)         => go().GetAIChatMessages(sessionID);
export const sendAIMessage       = (chatID, connID, t, contexts = []) => go().SendAIMessage(chatID, connID, t, contexts);
export const retryAIMessage      = (chatID, connID) => go().RetryAIMessage(chatID, connID);
export const approveAIToolCall   = (pendingID)         => go().ApproveAIToolCall(pendingID);
export const rejectAIToolCall    = (pendingID)         => go().RejectAIToolCall(pendingID);
export const setAIAutoExec       = (chatID, on)        => go().SetAIAutoExec(chatID, on);
export const stopAIRun           = (chatID)            => go().StopAIRun(chatID);
export const isAIRunActive       = (chatID)            => go().IsAIRunActive(chatID);

export const on  = (event, cb) => window.runtime.EventsOn(event, cb);
export const off = (event)     => window.runtime.EventsOff(event);
