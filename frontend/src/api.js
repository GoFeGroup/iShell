/**
 * api.js — typed wrappers around window.go.main.App.*
 * All methods return Promises.
 */

const go = () => window.go.main.App;

export const getSessions    = ()      => go().GetSessions();
export const getSession     = (id)    => go().GetSession(id);
export const saveSession    = (sess)  => go().SaveSession(sess);
export const deleteSession  = (id)    => go().DeleteSession(id);

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

export const listLocalDir   = (p)     => go().ListLocalDir(p);
export const getHomeDir     = ()      => go().GetHomeDir();
export const getDownloadsDir = ()     => go().GetDownloadsDir();
export const getRemotePWD   = (id)    => go().GetRemotePWD(id);

export const getSettings    = ()      => go().GetSettings();
export const saveSettings   = (s)     => go().SaveSettings(s);

export const getKnownHosts  = ()      => go().GetKnownHosts();
export const removeKnownHost= (h)     => go().RemoveKnownHost(h);
export const validateKey    = (p, pp) => go().ValidateKey(p, pp);
export const openKeyDialog  = ()      => go().OpenKeyFileDialog();

export const on  = (event, cb) => window.runtime.EventsOn(event, cb);
export const off = (event)     => window.runtime.EventsOff(event);
