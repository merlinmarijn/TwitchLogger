import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { workerUrl } from "./runtimeConfig";
import "./admin.css";

type AdminStatus = {
  configured: boolean;
  authenticated: boolean;
  totpEnabled: boolean;
  error?: string;
};

type JobKind = "image_reindex" | "view_reindex" | "integrity_scan" | "database_measurement";
type JobStatus = "queued" | "running" | "cancelling" | "cancelled" | "completed" | "failed";

type AdminJob = {
  _id: string;
  kind: JobKind;
  status: JobStatus;
  title: string;
  detail: string;
  current: number;
  total?: number;
  unit: string;
  error?: string;
  metadata?: { issues?: number; samples?: string[] };
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
};

type Dashboard = {
  generatedAt: number;
  auth: { totpEnabled: boolean; authRevision: number };
  jobs: AdminJob[];
  metrics: {
    functionCalls: number;
    errorCount: number;
    totalExecutionMs: number;
    cacheHits: number;
    cacheMisses: number;
    updatedAt: number;
  };
  databaseStats?: {
    generatedAt: number;
    documentCount: number;
    documentBytes: number;
    tables: Array<{ name: string; count: number; bytes: number }>;
    scope: string;
  };
  channels: { total: number; logging: number; connected: number; problems: number };
  latestMessageAt?: number;
  auditLog: Array<{ _id: string; event: string; detail: string; actor: string; createdAt: number }>;
};

const operations: Array<{
  kind: JobKind;
  number: string;
  title: string;
  description: string;
  impact: string;
}> = [
  {
    kind: "image_reindex",
    number: "01",
    title: "Re-index image links",
    description: "Re-read every message, extract supported artwork links, and refresh gallery membership.",
    impact: "Writes message metadata",
  },
  {
    kind: "view_reindex",
    number: "02",
    title: "Rebuild saved views",
    description: "Refresh every saved chat and gallery view revision and clear obsolete legacy matches.",
    impact: "Refreshes saved-view state",
  },
  {
    kind: "integrity_scan",
    number: "03",
    title: "Run integrity scan",
    description: "Check message-to-channel references and report damaged records without changing source data.",
    impact: "Read-only",
  },
  {
    kind: "database_measurement",
    number: "04",
    title: "Measure database",
    description: "Count rows and measure PostgreSQL relations to refresh the stored capacity report.",
    impact: "Read-only",
  },
];

export default function AdminApp() {
  const [status, setStatus] = useState<AdminStatus>();
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [notice, setNotice] = useState<string>();

  const loadStatus = useCallback(async () => {
    try {
      const next = await adminFetch<AdminStatus>("/auth/status");
      setStatus(next);
      return next;
    } catch (error) {
      setStatus({ configured: false, authenticated: false, totpEnabled: false, error: errorMessage(error) });
      return undefined;
    }
  }, []);

  useEffect(() => {
    document.title = "Admin · Twitch Logger";
    const timeout = window.setTimeout(() => void loadStatus(), 0);
    return () => window.clearTimeout(timeout);
  }, [loadStatus]);

  const loadDashboard = useCallback(async () => {
    try {
      const next = await adminFetch<Dashboard>("/dashboard");
      setDashboard(next);
    } catch (error) {
      if (error instanceof AdminRequestError && error.status === 401) {
        setStatus((current) => current ? { ...current, authenticated: false } : current);
        return;
      }
      setNotice(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    if (!status?.authenticated) return;
    const initial = window.setTimeout(() => void loadDashboard(), 0);
    const interval = window.setInterval(() => void loadDashboard(), 3_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [loadDashboard, status?.authenticated]);

  if (!status) return <AdminLoading />;
  if (!status.configured) {
    return (
      <SetupScreen
        unavailable={status.error}
        onComplete={async () => {
          const next = await loadStatus();
          if (next?.authenticated) setNotice("Super admin created. Your control plane is ready.");
        }}
      />
    );
  }
  if (!status.authenticated) {
    return <LoginScreen totpEnabled={status.totpEnabled} onComplete={loadStatus} />;
  }

  return (
    <DashboardScreen
      data={dashboard}
      notice={notice}
      onDismissNotice={() => setNotice(undefined)}
      onNotice={setNotice}
      onRefresh={loadDashboard}
      onSessionChanged={loadStatus}
    />
  );
}

function AdminLoading() {
  return (
    <main className="admin-loading">
      <span className="admin-seal">TL</span>
      <p>Opening the operations ledger…</p>
    </main>
  );
}

function SetupScreen({ unavailable, onComplete }: { unavailable?: string; onComplete: () => void }) {
  const [setupKey, setSetupKey] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) return setError("The two passwords do not match.");
    setBusy(true);
    setError(undefined);
    try {
      await adminFetch("/auth/setup", { method: "POST", body: { password, setupKey } });
      onComplete();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <main className="admin-auth-page">
      <AuthMasthead step="INITIAL SETUP" />
      <section className="auth-intro">
        <p className="auth-index">CONTROL / 01</p>
        <h1>Establish the<br /><em>control room.</em></h1>
        <p className="auth-lede">
          Create the only super admin credential. It is slow-hashed by the worker and stored only in PostgreSQL.
        </p>
        <div className="auth-assurance"><SignalIcon /><span>Credential material stays behind the worker security boundary.</span></div>
      </section>
      <form className="auth-sheet" onSubmit={submit}>
        <div className="sheet-rule"><span>SUPER ADMIN</span><span>ONE ACCOUNT</span></div>
        <h2>Unlock initial setup</h2>
        <p>Enter the worker's INGESTION_SECRET once, then choose a password of at least 12 characters.</p>
        {unavailable ? <InlineError>{unavailable}</InlineError> : null}
        <AuthField label="One-time setup key" hint="The INGESTION_SECRET configured on the worker">
          <input autoComplete="off" autoFocus onChange={(event) => setSetupKey(event.target.value)} required type="password" value={setupKey} />
        </AuthField>
        <AuthField label="Master password" hint="12–128 characters">
          <input autoComplete="new-password" minLength={12} maxLength={128} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
        </AuthField>
        <AuthField label="Confirm password">
          <input autoComplete="new-password" minLength={12} maxLength={128} onChange={(event) => setConfirm(event.target.value)} required type="password" value={confirm} />
        </AuthField>
        {error ? <InlineError>{error}</InlineError> : null}
        <button className="admin-primary wide" disabled={busy || Boolean(unavailable)}>
          {busy ? "Creating secure account…" : "Create super admin"}<ArrowIcon />
        </button>
        <small className="form-footnote">This setup closes permanently after the first account is created.</small>
      </form>
    </main>
  );
}

function LoginScreen({ totpEnabled, onComplete }: { totpEnabled: boolean; onComplete: () => void }) {
  const [mode, setMode] = useState<"password" | "totp">(totpEnabled ? "totp" : "password");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await adminFetch("/auth/login", {
        method: "POST",
        body: mode === "password" ? { password: value } : { code: value },
      });
      onComplete();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <main className="admin-auth-page login">
      <AuthMasthead step="AUTHORIZED ACCESS" />
      <section className="auth-intro">
        <p className="auth-index">CONTROL / RETURN</p>
        <h1>Good systems<br /><em>leave a trace.</em></h1>
        <p className="auth-lede">Sign in to inspect the archive, launch maintenance work, and follow every operation to completion.</p>
        <div className="auth-assurance"><LockIcon /><span>Sessions are signed, HttpOnly, and expire after twelve hours.</span></div>
      </section>
      <form className="auth-sheet" onSubmit={submit}>
        <div className="sheet-rule"><span>ADMIN SIGN IN</span><span>SECURE CHANNEL</span></div>
        <h2>Open the ledger</h2>
        {totpEnabled ? (
          <div className="auth-mode" role="tablist" aria-label="Sign-in method">
            <button aria-selected={mode === "totp"} onClick={() => { setMode("totp"); setValue(""); }} role="tab" type="button">Authenticator</button>
            <button aria-selected={mode === "password"} onClick={() => { setMode("password"); setValue(""); }} role="tab" type="button">Password</button>
          </div>
        ) : null}
        <AuthField label={mode === "totp" ? "Six-digit code" : "Master password"} hint={mode === "totp" ? "Refreshes every 30 seconds" : undefined}>
          <input
            autoComplete={mode === "totp" ? "one-time-code" : "current-password"}
            autoFocus
            className={mode === "totp" ? "code-input" : undefined}
            inputMode={mode === "totp" ? "numeric" : undefined}
            maxLength={mode === "totp" ? 6 : 128}
            onChange={(event) => setValue(mode === "totp" ? event.target.value.replace(/\D/g, "") : event.target.value)}
            pattern={mode === "totp" ? "[0-9]{6}" : undefined}
            required
            type={mode === "totp" ? "text" : "password"}
            value={value}
          />
        </AuthField>
        {error ? <InlineError>{error}</InlineError> : null}
        <button className="admin-primary wide" disabled={busy}>
          {busy ? "Verifying…" : "Enter admin"}<ArrowIcon />
        </button>
        <small className="form-footnote">Eight failed attempts lock this address for fifteen minutes.</small>
      </form>
    </main>
  );
}

function DashboardScreen({
  data,
  notice,
  onDismissNotice,
  onNotice,
  onRefresh,
  onSessionChanged,
}: {
  data?: Dashboard;
  notice?: string;
  onDismissNotice: () => void;
  onNotice: (message: string) => void;
  onRefresh: () => Promise<void>;
  onSessionChanged: () => void;
}) {
  const [working, setWorking] = useState<string>();
  const [securityOpen, setSecurityOpen] = useState(false);
  const activeJobs = data?.jobs.filter((job) => ["queued", "running", "cancelling"].includes(job.status)) ?? [];
  const maintenanceBusy = activeJobs.length > 0;

  const run = async (kind: JobKind) => {
    setWorking(kind);
    try {
      await adminFetch("/jobs", { method: "POST", body: { kind } });
      await onRefresh();
    } catch (error) {
      onNotice(errorMessage(error));
    } finally {
      setWorking(undefined);
    }
  };

  const cancel = async (jobId: string) => {
    setWorking(jobId);
    try {
      await adminFetch(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
      await onRefresh();
    } catch (error) {
      onNotice(errorMessage(error));
    } finally {
      setWorking(undefined);
    }
  };

  const logout = async () => {
    await adminFetch("/auth/logout", { method: "POST" });
    onSessionChanged();
  };

  return (
    <div className="admin-shell">
      <aside className="admin-rail">
        <a className="rail-brand" href="/"><span className="admin-seal small">TL</span><span>Twitch Logger<small>Control room</small></span></a>
        <nav aria-label="Admin sections">
          <a href="#overview"><OverviewIcon />Overview</a>
          <a href="#operations"><PulseIcon />Operations{activeJobs.length ? <b>{activeJobs.length}</b> : null}</a>
          <a href="#database"><DatabaseIcon />Database</a>
          <button onClick={() => setSecurityOpen((value) => !value)}><LockIcon />Security</button>
        </nav>
        <div className="rail-status">
          <span className={data?.channels.problems ? "attention" : ""} />
          <div><strong>{data?.channels.problems ? "Attention needed" : "Systems nominal"}</strong><small>Worker + PostgreSQL</small></div>
        </div>
        <button className="rail-logout" onClick={logout}>Sign out <ArrowIcon /></button>
      </aside>

      <main className="admin-main">
        {notice ? <button className="admin-notice" onClick={onDismissNotice}>{notice}<span>Dismiss</span></button> : null}
        <header className="admin-topline">
          <div><span>SUPER ADMIN</span><i /> <span>LIVE LEDGER</span></div>
          <time>{new Date().toLocaleDateString([], { weekday: "short", month: "short", day: "2-digit", year: "numeric" }).toUpperCase()}</time>
        </header>

        <section className="overview-section" id="overview">
          <div className="section-kicker"><span>01</span> SYSTEM OVERVIEW</div>
          <div className="overview-heading">
            <div><h1>The archive,<br /><em>under command.</em></h1><p>Live health and operational history, without leaving the application.</p></div>
            <Freshness data={data} />
          </div>
          <MetricsStrip data={data} />
        </section>

        <ActiveJobLedger activeJobs={activeJobs} onCancel={cancel} working={working} />

        <section className="admin-section" id="operations">
          <div className="section-heading">
            <div><div className="section-kicker"><span>02</span> OPERATIONS</div><h2>Maintenance, on demand</h2></div>
            <p>Operations run one at a time in paced, bounded batches so live logging and browsing stay responsive.</p>
          </div>
          <div className="operation-ledger">
            {operations.map((operation) => {
              const active = activeJobs.find((job) => job.kind === operation.kind);
              return (
                <article className="operation-row" key={operation.kind}>
                  <span className="operation-number">{operation.number}</span>
                  <div><h3>{operation.title}</h3><p>{operation.description}</p><small>{operation.impact}</small></div>
                  <button className="run-button" disabled={maintenanceBusy || Boolean(working)} onClick={() => void run(operation.kind)}>
                    {active ? "In progress" : maintenanceBusy ? "Maintenance busy" : working === operation.kind ? "Starting…" : "Run"}<ArrowIcon />
                  </button>
                </article>
              );
            })}
          </div>
        </section>

        <DatabaseSection
          data={data}
          onMeasure={() => void run("database_measurement")}
          disabled={maintenanceBusy || Boolean(working)}
          measuring={Boolean(activeJobs.find((job) => job.kind === "database_measurement"))}
        />
        <JobHistory jobs={data?.jobs ?? []} />
        <AuditTrail entries={data?.auditLog ?? []} />
      </main>

      {securityOpen ? <SecurityDrawer totpEnabled={data?.auth.totpEnabled ?? false} onClose={() => setSecurityOpen(false)} onChanged={async () => { await onRefresh(); onSessionChanged(); }} /> : null}
    </div>
  );
}

function MetricsStrip({ data }: { data?: Dashboard }) {
  const metrics = data?.metrics;
  const calls = metrics?.functionCalls ?? 0;
  const cacheTotal = (metrics?.cacheHits ?? 0) + (metrics?.cacheMisses ?? 0);
  const items = [
    { label: "Function calls", value: compact(calls), note: "Measured admin + worker calls" },
    { label: "Errors", value: compact(metrics?.errorCount ?? 0), note: calls ? `${(((metrics?.errorCount ?? 0) / calls) * 100).toFixed(2)}% of measured calls` : "No measured calls" },
    { label: "Avg. execution", value: calls ? `${Math.round((metrics?.totalExecutionMs ?? 0) / calls)} ms` : "—", note: "Worker and job batches" },
    { label: "Cache rate", value: cacheTotal ? `${Math.round(((metrics?.cacheHits ?? 0) / cacheTotal) * 100)}%` : "—", note: cacheTotal ? `${compact(cacheTotal)} cache decisions` : "Awaiting cache traffic" },
  ];
  return <div className="metrics-strip">{items.map((item) => <div key={item.label}><span>{item.label}</span><strong>{item.value}</strong><small>{item.note}</small></div>)}</div>;
}

function ActiveJobLedger({ activeJobs, onCancel, working }: { activeJobs: AdminJob[]; onCancel: (id: string) => void; working?: string }) {
  return (
    <section className={`active-ledger ${activeJobs.length ? "has-work" : ""}`} aria-live="polite">
      <div className="ledger-label"><PulseIcon /><span>ACTIVE<br />PROCESSES</span></div>
      {activeJobs.length === 0 ? (
        <div className="ledger-empty"><strong>No maintenance in flight</strong><span>New work will remain pinned here through refreshes.</span></div>
      ) : activeJobs.map((job) => {
        const percent = job.total && job.total > 0 ? Math.min(100, (job.current / job.total) * 100) : undefined;
        return (
          <div className="active-job" key={job._id}>
            <div className="job-line"><strong>{job.title}</strong><span>{job.status === "cancelling" ? "Stopping…" : percent === undefined ? compact(job.current) : `${Math.round(percent)}%`}</span></div>
            <div className="progress-track"><i style={{ transform: `scaleX(${percent === undefined ? 0.08 : percent / 100})` }} /></div>
            <small>{compact(job.current)}{job.total !== undefined ? ` / ${compact(job.total)}` : ""} {job.unit}</small>
            <button disabled={job.status === "cancelling" || working === job._id} onClick={() => onCancel(job._id)}>Abort</button>
          </div>
        );
      })}
    </section>
  );
}

function DatabaseSection({
  data,
  onMeasure,
  disabled,
  measuring,
}: {
  data?: Dashboard;
  onMeasure: () => void;
  disabled: boolean;
  measuring: boolean;
}) {
  const stats = data?.databaseStats;
  const maxBytes = Math.max(1, ...(stats?.tables.map((table) => table.bytes) ?? [1]));
  return (
    <section className="admin-section database-section" id="database">
      <div className="section-heading">
        <div><div className="section-kicker"><span>03</span> DATABASE</div><h2>What the archive weighs</h2></div>
        <button className="text-action" disabled={disabled} onClick={onMeasure}>{disabled ? measuring ? "Measuring…" : "Maintenance busy" : "Refresh measurement"}<ArrowIcon /></button>
      </div>
      {stats ? (
        <div className="database-layout">
          <div className="database-total"><span>DOCUMENT PAYLOAD</span><strong>{formatBytes(stats.documentBytes)}</strong><p>{compact(stats.documentCount)} documents measured {relativeTime(stats.generatedAt)}.</p><small>{stats.scope}</small></div>
          <div className="table-bars">
            {stats.tables.map((table) => (
              <div className="table-bar" key={table.name}>
                <div><strong>{humanize(table.name)}</strong><span>{compact(table.count)} docs · {formatBytes(table.bytes)}</span></div>
                <i><b style={{ transform: `scaleX(${table.bytes / maxBytes})` }} /></i>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="database-empty"><DatabaseIcon /><div><strong>No measurement yet</strong><p>Run the database measurement to create a persistent size and table-count snapshot.</p></div><button className="admin-primary" disabled={disabled} onClick={onMeasure}>Measure now</button></div>
      )}
    </section>
  );
}

function JobHistory({ jobs }: { jobs: AdminJob[] }) {
  const history = jobs.filter((job) => !["queued", "running", "cancelling"].includes(job.status)).slice(0, 8);
  return (
    <section className="admin-section history-section">
      <div className="section-heading"><div><div className="section-kicker"><span>04</span> RUN HISTORY</div><h2>Completed work</h2></div></div>
      {history.length ? <div className="history-table">
        <div className="history-head"><span>Operation</span><span>Result</span><span>Processed</span><span>Finished</span></div>
        {history.map((job) => <div className="history-row" key={job._id}><span><strong>{job.title}</strong><small>{job.error ?? job.detail}</small></span><StatusStamp status={job.status} /><span>{compact(job.current)} {job.unit}</span><time>{job.finishedAt ? relativeTime(job.finishedAt) : "—"}</time></div>)}
      </div> : <p className="quiet-empty">The first completed operation will be recorded here.</p>}
    </section>
  );
}

function AuditTrail({ entries }: { entries: Dashboard["auditLog"] }) {
  return (
    <section className="admin-section audit-section">
      <div className="section-heading"><div><div className="section-kicker"><span>05</span> AUDIT TRAIL</div><h2>Every privileged action</h2></div></div>
      <div className="audit-list">{entries.length ? entries.map((entry) => <div key={entry._id}><i /><time>{new Date(entry.createdAt).toLocaleString()}</time><strong>{entry.detail}</strong><span>{entry.actor}</span></div>) : <p className="quiet-empty">No privileged actions recorded.</p>}</div>
    </section>
  );
}

function SecurityDrawer({ totpEnabled, onClose, onChanged }: { totpEnabled: boolean; onClose: () => void; onChanged: () => void }) {
  const [enrollment, setEnrollment] = useState<{ enrollmentToken: string; qrCode: string; secret: string }>();
  const [code, setCode] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const begin = async () => {
    setBusy(true); setError(undefined);
    try { setEnrollment(await adminFetch("/auth/totp/begin", { method: "POST" })); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    if (!enrollment) return;
    setBusy(true); setError(undefined);
    try {
      await adminFetch("/auth/totp/confirm", { method: "POST", body: { enrollmentToken: enrollment.enrollmentToken, code } });
      setEnrollment(undefined); setCode(""); await onChanged();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const changePassword = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(undefined);
    try {
      await adminFetch("/auth/password", { method: "POST", body: { currentPassword, newPassword } });
      setCurrentPassword(""); setNewPassword(""); await onChanged();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };

  return (
    <aside className="security-drawer" aria-label="Security settings">
      <button className="drawer-close" onClick={onClose} aria-label="Close security settings">×</button>
      <div className="section-kicker"><span>S</span> SECURITY</div>
      <h2>Protect the control room</h2>
      <section>
        <div className="security-heading"><div><h3>Authenticator app</h3><p>{totpEnabled ? "Code-only sign-in is active." : "Pair any standards-based authenticator."}</p></div><StatusStamp status={totpEnabled ? "completed" : "cancelled"} label={totpEnabled ? "Enabled" : "Not paired"} /></div>
        {!enrollment ? <button className="drawer-action" disabled={busy} onClick={() => void begin()}>{totpEnabled ? "Replace authenticator" : "Set up authenticator"}<ArrowIcon /></button> : (
          <form className="enrollment" onSubmit={confirm}>
            <img alt="Authenticator setup QR code" src={enrollment.qrCode} />
            <p>Scan this QR code, then enter the current six-digit code.</p>
            <code>{enrollment.secret.match(/.{1,4}/g)?.join(" ")}</code>
            <input aria-label="Authenticator code" autoComplete="one-time-code" inputMode="numeric" maxLength={6} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} pattern="[0-9]{6}" placeholder="000000" required value={code} />
            <button className="admin-primary" disabled={busy}>Confirm pairing</button>
          </form>
        )}
      </section>
      <form onSubmit={changePassword}>
        <div className="security-heading"><div><h3>Master password</h3><p>Changing it revokes every existing session.</p></div></div>
        <AuthField label="Current password"><input autoComplete="current-password" onChange={(event) => setCurrentPassword(event.target.value)} required type="password" value={currentPassword} /></AuthField>
        <AuthField label="New password" hint="12–128 characters"><input autoComplete="new-password" minLength={12} maxLength={128} onChange={(event) => setNewPassword(event.target.value)} required type="password" value={newPassword} /></AuthField>
        <button className="drawer-action" disabled={busy}>Change password<ArrowIcon /></button>
      </form>
      {error ? <InlineError>{error}</InlineError> : null}
    </aside>
  );
}

function AuthMasthead({ step }: { step: string }) {
  return <header className="auth-masthead"><a href="/"><span className="admin-seal">TL</span><span>Twitch Logger<small>Operations</small></span></a><span>{step}</span></header>;
}

function AuthField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="admin-field"><span>{label}{hint ? <small>{hint}</small> : null}</span>{children}</label>;
}

function InlineError({ children }: { children: ReactNode }) { return <div className="admin-error"><span>!</span>{children}</div>; }
function Freshness({ data }: { data?: Dashboard }) { return <div className="freshness"><i /><span>Live data<small>{data ? `Updated ${relativeTime(data.generatedAt)}` : "Connecting…"}</small></span></div>; }
function StatusStamp({ status, label }: { status: JobStatus; label?: string }) { return <span className={`status-stamp ${status}`}><i />{label ?? humanize(status)}</span>; }

function compact(value: number) { return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value); }
function formatBytes(bytes: number) { const units = ["B", "kB", "MB", "GB", "TB"]; let value = bytes; let index = 0; while (value >= 1_000 && index < units.length - 1) { value /= 1_000; index += 1; } return `${value.toFixed(index === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[index]}`; }
function humanize(value: string) { return value.replaceAll(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()); }
function relativeTime(timestamp: number) { const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000)); if (seconds < 5) return "just now"; if (seconds < 60) return `${seconds}s ago`; const minutes = Math.round(seconds / 60); if (minutes < 60) return `${minutes}m ago`; const hours = Math.round(minutes / 60); if (hours < 24) return `${hours}h ago`; return `${Math.round(hours / 24)}d ago`; }

async function adminFetch<T = unknown>(path: string, options: { method?: "POST"; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${workerUrl}/api/admin${path}`, {
    method: options.method ?? "GET",
    credentials: "include",
    headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new AdminRequestError(body.error ?? "Admin request failed", response.status);
  return body;
}

class AdminRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Something went wrong"; }

function ArrowIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6" /></svg>; }
function SignalIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 18v2M9 14v6M14 9v11M19 4v16" /></svg>; }
function LockIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="1" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>; }
function OverviewIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 13h6V4H4v9Zm10 7h6V11h-6v9ZM4 20h6v-3H4v3Zm10-13h6V4h-6v3Z" /></svg>; }
function PulseIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 12h4l2-6 4 12 2-6h6" /></svg>; }
function DatabaseIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" /></svg>; }
