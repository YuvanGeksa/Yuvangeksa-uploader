"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

// =========================
// CONFIG (ANY REPO MODE)
// =========================
// User cukup isi token + owner + repo + ZIP di website, lalu upload.
// Tidak ada whitelist. Token tidak disimpan (dipakai hanya di browser).
// Catatan: kalau situs publik, pertimbangkan Access Code / rate limit di versi berikutnya.

const DEFAULT_OWNER = "Yopandelreyz";
const DEFAULT_REPO = "test-upload";

// Default behaviour: bikin branch baru biar aman
const DEFAULT_CREATE_BRANCH = true;

// Batasi file biar tidak bikin browser ngadat (bisa kamu naikkan)
const MAX_FILES = 2000;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024; // 60MB total extracted

function nowTime() {
  const d = new Date();
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, b = bytes;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function sanitizePath(p) {
  // normalize slashes, remove leading ./, prevent path traversal
  let s = p.replace(/\\/g, "/");
  s = s.replace(/^\.+\//, "");     // remove leading ./ or ../
  s = s.replace(/\/+/, "/");
  s = s.replace(/\0/g, "");
  s = s.replace(/^\//, "");
  s = s.replace(/\.\.(\/|$)/g, "");
  return s;
}

function base64FromUint8(u8) {
  // browser-safe base64 without huge call stack
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function ghFetch(token, path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });

  const txt = await res.text();
  let json = null;
  try { json = txt ? JSON.parse(txt) : null; } catch { json = null; }

  if (!res.ok) {
    const msg = (json && (json.message || json.error)) ? (json.message || json.error) : txt || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

async function getDefaultBranch(token, owner, repo) {
  const r = await ghFetch(token, `/repos/${owner}/${repo}`);
  return r.default_branch || "main";
}

async function ensureBranch(token, owner, repo, baseBranch, newBranchName, log) {
  const baseRef = await ghFetch(
    token,
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`
  );
  const sha = baseRef.object.sha;
  log(`✔ Base branch SHA: ${sha.slice(0, 7)}`, "ok");

  try {
    await ghFetch(token, `/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${newBranchName}`, sha }),
    });
    log(`✔ Created branch ${newBranchName}`, "ok");
  } catch (e) {
    if (String(e.message || "").includes("Reference already exists")) {
      log(`⚠ Branch already exists, will reuse: ${newBranchName}`, "warn");
    } else {
      throw e;
    }
  }
  return newBranchName;
}

async function uploadFilesContentsApi({ token, owner, repo, branch, files, commitMsg, log, onProgress }) {
  let done = 0;
  const total = files.length;

  const concurrency = 1;
  let idx = 0;

  async function worker() {
    while (idx < total) {
      const my = idx++;
      const f = files[my];

      const path = sanitizePath(f.path);
      const contentB64 = base64FromUint8(f.bytes);
      const body = { message: commitMsg, content: contentB64, branch };

      // include sha if updating existing file
      let sha = null;
      try {
        const existing = await ghFetch(
          token,
          `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`
        );
        if (existing && existing.sha) sha = existing.sha;
      } catch (e) {
        if (e.status !== 404) throw e; // 404 ok
      }
      if (sha) body.sha = sha;

      await ghFetch(token, `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });

      done++;
      onProgress?.(done, total, path);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  log(`✔ Uploaded ${done}/${total} files`, "ok");
}

export default function Page() {
  const [step, setStep] = useState(1);
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);

  const [owner, setOwner] = useState(DEFAULT_OWNER);
  const [repo, setRepo] = useState(DEFAULT_REPO);

  const [zipName, setZipName] = useState("");
  const [zipSize, setZipSize] = useState(0);

  const [files, setFiles] = useState([]); // {path, bytes(Uint8Array), size}
  const [totalBytes, setTotalBytes] = useState(0);

  const [branchMode, setBranchMode] = useState(DEFAULT_CREATE_BRANCH ? "new" : "default");
  const [branchName, setBranchName] = useState("");
  const [commitMsg, setCommitMsg] = useState("Upload from ZIP via Web Uploader");

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0, last: "" });

  const [logLines, setLogLines] = useState([]);
  const logRef = useRef(null);

  const fullRepo = useMemo(
    () => `${(owner || "").trim()}/${(repo || "").trim()}`.replace(/^\/+|\/+$/g, ""),
    [owner, repo]
  );

  useEffect(() => {
    function onErr(event) {
      const msg = event?.message || (event?.error && event.error.message) || "Unknown error";
      try { console.error("Client error:", event?.error || event); } catch {}
      setLogLines((prev) =>
        [...prev, { line: `[${nowTime()}] ✖ Client error: ${msg}`, kind: "err" }].slice(-400)
      );
    }
    window.addEventListener("error", onErr);
    return () => window.removeEventListener("error", onErr);
  }, []);

  function addLog(msg, kind) {
    const line = `[${nowTime()}] ${msg}`;
    setLogLines((prev) => {
      const next = [...prev, { line, kind: kind || "" }];
      return next.slice(-400);
    });
    setTimeout(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    }, 0);
  }

  const steps = useMemo(
    () => [
      { n: 1, t: "GitHub Access" },
      { n: 2, t: "Select ZIP" },
      { n: 3, t: "Review" },
      { n: 4, t: "Upload" },
    ],
    []
  );

  async function handleValidate() {
    setErr("");
    setOk("");
    if (!token.trim()) { setErr("Token wajib diisi."); return; }
    if (!owner.trim() || !repo.trim()) { setErr("Owner dan repository wajib diisi."); return; }

    setBusy(true);
    try {
      addLog("→ Validating token…", "warn");
      const me = await ghFetch(token.trim(), "/user");
      addLog(`✔ Token valid for @${me.login}`, "ok");

      addLog("→ Checking repository access…", "warn");
      await ghFetch(token.trim(), `/repos/${owner.trim()}/${repo.trim()}`);
      addLog(`✔ Repo found: ${owner.trim()}/${repo.trim()}`, "ok");

      setOk("Akses OK. Lanjut pilih ZIP.");
      setStep(2);
    } catch (e) {
      setErr(`Gagal: ${e.message}`);
      addLog(`✖ ${e.message}`, "err");
    } finally {
      setBusy(false);
    }
  }

  async function handleZip(file) {
    setErr("");
    setOk("");
    setZipName(file?.name || "");
    setZipSize(file?.size || 0);
    setFiles([]);
    setTotalBytes(0);

    if (!file) return;

    setBusy(true);
    try {
      addLog("→ Reading ZIP…", "warn");
      const buf = new Uint8Array(await file.arrayBuffer());
      addLog("→ Extracting ZIP in browser…", "warn");

      // dynamic import (lebih aman di build/runtime)
      const { unzipSync } = await import("fflate");
      const unzipped = unzipSync(buf);

      const list = [];
      let bytesSum = 0;
      let count = 0;

      for (const [path, u8] of Object.entries(unzipped)) {
        if (path.endsWith("/")) continue;
        const clean = sanitizePath(path);

        if (!clean) continue;
        if (clean.startsWith("__MACOSX/")) continue;
        if (clean.endsWith(".DS_Store")) continue;

        const size = u8.byteLength;
        bytesSum += size;
        count++;

        if (count > MAX_FILES) throw new Error(`Terlalu banyak file (> ${MAX_FILES}).`);
        if (bytesSum > MAX_TOTAL_BYTES) throw new Error(`Total extracted terlalu besar (> ${formatBytes(MAX_TOTAL_BYTES)}).`);

        list.push({ path: clean, bytes: u8, size });
      }

      if (!list.length) throw new Error("ZIP kosong atau tidak ada file yang bisa diupload.");

      setFiles(list);
      setTotalBytes(bytesSum);

      addLog(`✔ Extracted ${list.length} files (${formatBytes(bytesSum)})`, "ok");
      setOk("ZIP siap. Lanjut review.");
      setStep(3);
    } catch (e) {
      setErr(e.message);
      addLog(`✖ ${e.message}`, "err");
    } finally {
      setBusy(false);
    }
  }

  async function handleUpload() {
    setErr("");
    setOk("");
    setBusy(true);
    setProgress({ done: 0, total: files.length, last: "" });

    try {
      addLog("→ Resolving default branch…", "warn");
      const defaultBranch = await getDefaultBranch(token.trim(), owner.trim(), repo.trim());
      addLog(`✔ Default branch: ${defaultBranch}`, "ok");

      let targetBranch = defaultBranch;
      if (branchMode === "new") {
        const stamp = new Date().toISOString().slice(0, 10);
        const safe = (branchName || `upload-${stamp}`).replace(/[^a-zA-Z0-9._\-/]/g, "-");
        addLog(`→ Creating/using branch: ${safe}`, "warn");
        targetBranch = await ensureBranch(token.trim(), owner.trim(), repo.trim(), defaultBranch, safe, addLog);
      }

      addLog("→ Uploading files…", "warn");
      await uploadFilesContentsApi({
        token: token.trim(),
        owner: owner.trim(),
        repo: repo.trim(),
        branch: targetBranch,
        files,
        commitMsg,
        log: addLog,
        onProgress: (done, total, last) => {
          setProgress({ done, total, last });
          if (done % 25 === 0 || done === total) {
            addLog(`→ Uploaded ${done}/${total} (${last})`, "warn");
          }
        },
      });

      const repoUrl = `https://github.com/${owner.trim()}/${repo.trim()}`;
      const branchUrl = `${repoUrl}/tree/${encodeURIComponent(targetBranch)}`;

      setOk(`Sukses! Open: ${branchUrl}`);
      addLog("✔ Upload complete.", "ok");
      addLog(`✔ ${branchUrl}`, "ok");
      setStep(4);
    } catch (e) {
      setErr(`Upload gagal: ${e.message}`);
      addLog(`✖ Upload failed: ${e.message}`, "err");
    } finally {
      setBusy(false);
    }
  }

  const canNext3 = files.length > 0;
  const canUpload = token.trim() && files.length > 0 && commitMsg.trim();

  return (
    <div className="container">
      <div className="topbar">
        <div className="devname">Yopandelreyz</div>
        <div style={{ opacity: 0.9 }}>{fullRepo}</div>
      </div>

      <div className="surface">
        <div className="hero">
          <h1 className="h1">Upload to GitHub</h1>
          <p className="sub">One UI-inspired ZIP uploader. Isi token + owner + repo + ZIP, lalu upload.</p>
        </div>

        <div className="stepper">
          {steps.map((s) => (
            <div key={s.n} className={"pill" + (step === s.n ? " active" : "")}>
              {s.n}. {s.t}
            </div>
          ))}
        </div>

        {err ? (
          <div className="card">
            <div className="notice">{err}</div>
          </div>
        ) : null}
        {ok ? (
          <div className="card">
            <div className="success">{ok}</div>
          </div>
        ) : null}

        {step === 1 && (
          <div className="card">
            <div className="field">
              <div className="label">GitHub Token</div>
              <div className="row">
                <input
                  className="input"
                  type={showToken ? "text" : "password"}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="ghp_..."
                  autoComplete="off"
                  spellCheck={false}
                />
                <button className="eyeBtn" onClick={() => setShowToken((v) => !v)} type="button" aria-label="Toggle token visibility">
                  {showToken ? "🙈" : "👁️"}
                </button>
              </div>
              <div className="hint">Token tidak disimpan. Dipakai hanya di browser untuk akses GitHub API.</div>
            </div>

            <div className="grid">
              <div className="field">
                <div className="label">Owner / Username</div>
                <input
                  className="input"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  placeholder="misal: Yopandelreyz"
                  spellCheck={false}
                />
                <div className="hint">Ini pemilik repo (user/organization).</div>
              </div>
              <div className="field">
                <div className="label">Repository</div>
                <input
                  className="input"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  placeholder="misal: test-upload"
                  spellCheck={false}
                />
                <div className="hint">Nama repo tujuan upload.</div>
              </div>
            </div>

            <div className="hint">
              Upload akan berhasil kalau token kamu punya akses <b>write</b> ke repo: <b>{fullRepo}</b>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="card">
            <div className="label" style={{ marginBottom: 8 }}>ZIP file</div>
            <div className="drop">
              <div>
                <strong>Drag & drop ZIP</strong>
                <div className="muted">atau tap untuk pilih file .zip</div>
              </div>
              <label className="btn">
                Browse ZIP
                <input type="file" accept=".zip,application/zip" onChange={(e) => handleZip(e.target.files?.[0])} />
              </label>
            </div>

            {zipName ? (
              <div style={{ marginTop: 12 }} className="kv">
                <div className="k">Filename</div><div className="v">{zipName}</div>
                <div className="k">Size</div><div className="v">{formatBytes(zipSize)}</div>
                <div className="k">Extracted</div><div className="v">{files.length ? `${files.length} files • ${formatBytes(totalBytes)}` : "-"}</div>
              </div>
            ) : null}
          </div>
        )}

        {step === 3 && (
          <div className="card">
            <div className="kv">
              <div className="k">Repo</div><div className="v">{fullRepo}</div>
              <div className="k">Files</div><div className="v">{files.length} • {formatBytes(totalBytes)}</div>
            </div>

            <div className="field" style={{ marginTop: 12 }}>
              <div className="label">Commit message</div>
              <input className="input" value={commitMsg} onChange={(e) => setCommitMsg(e.target.value)} />
            </div>

            <div className="toggleRow">
              <label className="toggle">
                <input type="radio" name="branchMode" checked={branchMode === "default"} onChange={() => setBranchMode("default")} />
                Upload to default branch
              </label>
              <label className="toggle">
                <input type="radio" name="branchMode" checked={branchMode === "new"} onChange={() => setBranchMode("new")} />
                Create/use new branch
              </label>
            </div>

            {branchMode === "new" ? (
              <div className="field" style={{ marginTop: 10 }}>
                <div className="label">Branch name (optional)</div>
                <input className="input" value={branchName} onChange={(e) => setBranchName(e.target.value)} placeholder="upload-2026-01-02" />
                <div className="hint">Kalau kosong, otomatis: <b>upload-YYYY-MM-DD</b></div>
              </div>
            ) : null}

            <div className="hint">Catatan: mode ini pakai Contents API (upload per file). Untuk ribuan file, bisa butuh waktu.</div>
          </div>
        )}

        {step === 4 && (
          <div className="card">
            <div className="label">Status</div>
            <div className="hint" style={{ marginTop: 6 }}>
              {busy ? (
                <span>Uploading… {progress.done}/{progress.total} {progress.last ? `• ${progress.last}` : ""}</span>
              ) : (
                <span>Done. Cek log di bawah untuk link.</span>
              )}
            </div>
          </div>
        )}

        <div className="logWrap">
          <div className="logTitle">
            <div>&gt;_ Activity Log</div>
            <div style={{ color: "#64748b", fontFamily: "var(--mono)", fontWeight: 700 }}>{logLines.length} lines</div>
          </div>
          <div className="log" ref={logRef}>
            {logLines.length ? (
              logLines.map((x, i) => (
                <div key={i} className={x.kind || ""}>{x.line}</div>
              ))
            ) : (
              <div style={{ opacity: 0.7 }}>[{nowTime()}] Ready.</div>
            )}
          </div>
        </div>

        <div className="footer">© 2024 GitHub File Uploader • <b>Yopandelreyz</b></div>

        <div className="stickyCta">
          <div className="ctaBar">
            {step > 1 ? (
              <button className="btnGhost" onClick={() => setStep((s) => Math.max(1, s - 1))} disabled={busy}>Back</button>
            ) : (
              <button
                className="btnGhost"
                onClick={() => {
                  setToken("");
                  setFiles([]);
                  setZipName("");
                  setZipSize(0);
                  setLogLines([]);
                  setOwner(DEFAULT_OWNER);
                  setRepo(DEFAULT_REPO);
                  setErr("");
                  setOk("");
                  setStep(1);
                }}
                disabled={busy}
              >
                Reset
              </button>
            )}

            {step === 1 && (
              <button className="btnPrimary" onClick={handleValidate} disabled={busy || !token.trim()}>
                {busy ? "Checking…" : "Next →"}
              </button>
            )}
            {step === 2 && (
              <button className="btnPrimary" onClick={() => setStep(3)} disabled={busy || !canNext3}>
                Continue →
              </button>
            )}
            {step === 3 && (
              <button className="btnPrimary" onClick={handleUpload} disabled={busy || !canUpload}>
                {busy ? "Uploading…" : "🚀 Upload Now"}
              </button>
            )}
            {step === 4 && (
              <button className="btnPrimary" onClick={() => setStep(1)} disabled={busy}>
                New Upload
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
