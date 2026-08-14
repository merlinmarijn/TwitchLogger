import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  FEEDBACK_FLAG_DEFINITIONS,
  isFeedbackFlagAllowed,
  type FeedbackFlag,
  type FeedbackKind,
  type FeedbackStatus,
} from "../shared/feedback";
import { workerUrl } from "./runtimeConfig";
import "./admin.css";

type AdminStatus = {
  configured: boolean;
  authenticated: boolean;
  totpEnabled: boolean;
  error?: string;
};

type StartableJobKind =
  | "image_reindex"
  | "view_reindex"
  | "integrity_scan"
  | "database_measurement";
type JobKind = StartableJobKind | "archive_reencode";
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

type FeedbackSubmission = {
  _id: string;
  kind: FeedbackKind;
  description: string;
  contactUsername?: string;
  status: FeedbackStatus;
  flags: FeedbackFlag[];
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
};

type FeedbackResponse = {
  submissions: FeedbackSubmission[];
  total: number;
  page: number;
  pageSize: number;
  summary: {
    total: number;
    open: number;
    closed: number;
    feedback: number;
    issues: number;
    unclassified: number;
  };
};

const operations: Array<{
  kind: StartableJobKind;
  number: string;
  title: string;
  description: string;
  impact: string;
}> = [
  {
    kind: "image_reindex",
    number: "01",
    title: "Re-index image links",
    description: "Re-read every message, inspect linked files, refresh gallery membership, and remove duplicate image URLs.",
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
      <img alt="" className="admin-seal" src="/brand/twitch-logger-icon-64.png" />
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
        <p className="auth-index">TWITCH LOGGER / ADMINISTRATION</p>
        <h1>Bring the control plane online.</h1>
        <p className="auth-lede">
          Create the only super admin credential. It is slow-hashed by the worker and stored only in PostgreSQL.
        </p>
        <AuthTelemetry />
        <div className="auth-assurance"><SignalIcon /><span>Credential material stays behind the worker security boundary.</span></div>
      </section>
      <form className="auth-sheet" onSubmit={submit}>
        <div className="sheet-rule"><span>SUPER ADMIN</span><span>SETUP 1 OF 1</span></div>
        <h2>Create the administrator</h2>
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
  const submitting = useRef(false);

  const authenticate = async (credential: string) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await adminFetch("/auth/login", {
        method: "POST",
        body: mode === "password" ? { password: credential } : { code: credential },
      });
      onComplete();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
      submitting.current = false;
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void authenticate(value);
  };

  const updateValue = (nextValue: string) => {
    const normalizedValue = mode === "totp" ? nextValue.replace(/\D/g, "").slice(0, 6) : nextValue;
    setValue(normalizedValue);
    if (mode === "totp" && normalizedValue.length === 6) void authenticate(normalizedValue);
  };

  return (
    <main className="admin-auth-page login">
      <AuthMasthead step="AUTHORIZED ACCESS" />
      <section className="auth-intro">
        <p className="auth-index">TWITCH LOGGER / ADMINISTRATION</p>
        <h1>Observe the archive. Operate with confidence.</h1>
        <p className="auth-lede">A single workspace for archive health, user reports, maintenance work, and security controls.</p>
        <AuthTelemetry />
        <div className="auth-assurance"><LockIcon /><span>Sessions are signed, HttpOnly, and expire after twelve hours.</span></div>
      </section>
      <form className="auth-sheet" onSubmit={submit}>
        <div className="sheet-rule"><span>ADMIN SIGN IN</span><span>SECURE SESSION</span></div>
        <h2>Sign in to Twitch Logger</h2>
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
            onChange={(event) => updateValue(event.target.value)}
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
  const [jumpQuery, setJumpQuery] = useState("");
  const activeJobs = data?.jobs.filter((job) => ["queued", "running", "cancelling"].includes(job.status)) ?? [];
  const maintenanceBusy = activeJobs.length > 0;

  const run = async (kind: StartableJobKind) => {
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

  const jumpToSection = (queryInput = jumpQuery) => {
    const query = queryInput.trim().toLowerCase();
    const sections = [
      { id: "overview", terms: "overview system health dashboard" },
      { id: "submissions", terms: "submissions feedback inbox issues bug reports" },
      { id: "operations", terms: "operations maintenance jobs reindex integrity" },
      { id: "database", terms: "database storage postgres measurement" },
      { id: "history", terms: "history completed runs jobs" },
      { id: "audit", terms: "audit security events trail" },
    ];
    const match = sections.find((section) => section.terms.includes(query));
    if (match) {
      document.getElementById(match.id)?.scrollIntoView({ block: "start" });
      window.history.pushState(null, "", `#${match.id}`);
    } else onNotice(`No admin section matches “${queryInput}”.`);
    setJumpQuery("");
  };

  return (
    <div className="admin-shell">
      <header className="admin-globalbar">
        <a className="global-brand" href="/"><img alt="" className="admin-seal small" src="/brand/twitch-logger-icon-64.png" /><span>Twitch Logger</span></a>
        <form className="admin-jump" onSubmit={(event) => { event.preventDefault(); jumpToSection(); }}>
          <SearchIcon />
          <input aria-label="Jump to admin section" list="admin-sections" onChange={(event) => setJumpQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); jumpToSection(event.currentTarget.value); } }} placeholder="Search or jump to…" value={jumpQuery} />
          <datalist id="admin-sections"><option value="Overview" /><option value="Submissions" /><option value="Operations" /><option value="Database" /><option value="History" /><option value="Audit" /></datalist>
          <kbd>/</kbd>
          <button aria-label="Jump" className="admin-jump-go" type="submit"><ArrowIcon /></button>
        </form>
        <div className="global-actions">
          <button aria-label="Open security settings" onClick={() => setSecurityOpen(true)} title="Security"><LockIcon /></button>
          <span className="admin-avatar" title="Super admin">SA</span>
        </div>
      </header>
      <aside className="admin-rail">
        <div className="rail-heading"><span>Administration</span><small>Control plane</small></div>
        <nav aria-label="Admin sections">
          <a className="active" href="#overview"><OverviewIcon />Overview</a>
          <a href="#submissions"><InboxIcon />Submissions</a>
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
          <div className="admin-breadcrumb"><a href="/">Home</a><span>/</span><span>Administration</span><span>/</span><strong>Overview</strong></div>
          <div className="topline-actions"><button onClick={() => void onRefresh()}><RefreshIcon />Refresh</button><time>{new Date().toLocaleDateString([], { month: "short", day: "2-digit", year: "numeric" })}</time></div>
        </header>

        <section className="overview-section" id="overview">
          <div className="overview-heading">
            <div><div className="section-kicker"><span>01</span> SYSTEM OVERVIEW</div><h1>Operations overview</h1><p>Live archive health, worker activity, and administrative workload.</p></div>
            <Freshness data={data} />
          </div>
          <MetricsStrip data={data} />
          <SystemsOverview data={data} />
        </section>

        <ActiveJobLedger activeJobs={activeJobs} onCancel={cancel} working={working} />

        <FeedbackWorkspace onNotice={onNotice} />

        <section className="admin-section" id="operations">
          <div className="section-heading">
            <div><div className="section-kicker"><span>03</span> OPERATIONS</div><h2>Maintenance, on demand</h2></div>
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
    { label: "Function calls", value: compact(calls), note: "Admin + worker calls", tone: "blue" },
    { label: "Errors", value: compact(metrics?.errorCount ?? 0), note: calls ? `${(((metrics?.errorCount ?? 0) / calls) * 100).toFixed(2)}% error rate` : "No measured calls", tone: (metrics?.errorCount ?? 0) > 0 ? "red" : "green" },
    { label: "Avg. execution", value: calls ? `${Math.round((metrics?.totalExecutionMs ?? 0) / calls)} ms` : "—", note: "Worker + job batches", tone: "orange" },
    { label: "Cache hit rate", value: cacheTotal ? `${Math.round(((metrics?.cacheHits ?? 0) / cacheTotal) * 100)}%` : "—", note: cacheTotal ? `${compact(cacheTotal)} decisions` : "Awaiting cache traffic", tone: "purple" },
  ];
  return <div className="metrics-strip">{items.map((item) => <article className={`metric-panel ${item.tone}`} key={item.label}><header><span>{item.label}</span><i /></header><strong>{item.value}</strong><small>{item.note}</small><div className="metric-baseline" /></article>)}</div>;
}

function SystemsOverview({ data }: { data?: Dashboard }) {
  const channels = data?.channels;
  const connectedRate = channels?.total ? Math.round((channels.connected / channels.total) * 100) : 0;
  const loggingRate = channels?.total ? Math.round((channels.logging / channels.total) * 100) : 0;
  return (
    <div className="systems-grid">
      <article className="admin-panel channel-panel">
        <header><div><span>Channel health</span><small>Worker subscription state</small></div><StatusStamp status={channels?.problems ? "failed" : "completed"} label={channels?.problems ? `${channels.problems} problem${channels.problems === 1 ? "" : "s"}` : "Nominal"} /></header>
        <div className="channel-stats">
          <div><strong>{compact(channels?.total ?? 0)}</strong><span>Configured</span></div>
          <div><strong>{compact(channels?.logging ?? 0)}</strong><span>Logging</span></div>
          <div><strong>{compact(channels?.connected ?? 0)}</strong><span>Connected</span></div>
          <div><strong>{compact(channels?.problems ?? 0)}</strong><span>Problems</span></div>
        </div>
      </article>
      <article className="admin-panel service-panel">
        <header><div><span>Service readiness</span><small>Current connected capacity</small></div><Freshness data={data} /></header>
        <div className="service-gauge"><div><span>Connected channels</span><strong>{connectedRate}%</strong></div><i><b style={{ transform: `scaleX(${connectedRate / 100})` }} /></i></div>
        <div className="service-gauge logging"><div><span>Actively logging</span><strong>{loggingRate}%</strong></div><i><b style={{ transform: `scaleX(${loggingRate / 100})` }} /></i></div>
        <small className="last-message">Latest archived message: {data?.latestMessageAt ? relativeTime(data.latestMessageAt) : "No messages recorded"}</small>
      </article>
    </div>
  );
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

function FeedbackWorkspace({ onNotice }: { onNotice: (message: string) => void }) {
  const [data, setData] = useState<FeedbackResponse>();
  const [kind, setKind] = useState<"all" | FeedbackKind>("all");
  const [status, setStatus] = useState<"all" | FeedbackStatus>("open");
  const [flag, setFlag] = useState<"all" | FeedbackFlag>("all");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string>();

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: "50" });
    if (kind !== "all") params.set("kind", kind);
    if (status !== "all") params.set("status", status);
    if (flag !== "all") params.set("flag", flag);
    if (search) params.set("search", search);
    try {
      const next = await adminFetch<FeedbackResponse>(`/feedback?${params}`);
      setData(next);
      setSelectedId((current) =>
        current && next.submissions.some((submission) => submission._id === current)
          ? current
          : next.submissions[0]?._id
      );
    } catch (error) {
      onNotice(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [flag, kind, onNotice, page, search, status]);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      setLoading(true);
      void load();
    }, 0);
    const interval = window.setInterval(() => void load(), 15_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [load]);

  const save = async (
    submission: FeedbackSubmission,
    nextStatus: FeedbackStatus,
    nextFlags: FeedbackFlag[],
  ) => {
    setWorking(submission._id);
    try {
      await adminFetch(`/feedback/${encodeURIComponent(submission._id)}`, {
        method: "POST",
        body: { status: nextStatus, flags: nextFlags },
      });
      await load();
      onNotice(`${submission.kind === "issue" ? "Issue" : "Feedback"} #${submission._id} updated.`);
    } catch (error) {
      onNotice(errorMessage(error));
    } finally {
      setWorking(undefined);
    }
  };

  const selected = data?.submissions.find((submission) => submission._id === selectedId);
  const pageCount = data ? Math.ceil(data.total / data.pageSize) : 0;
  const summaryItems = [
    { label: "Open", value: data?.summary.open ?? 0 },
    { label: "Bug reports", value: data?.summary.issues ?? 0 },
    { label: "Feedback", value: data?.summary.feedback ?? 0 },
    { label: "Unclassified", value: data?.summary.unclassified ?? 0 },
  ];

  return (
    <section className="admin-section submissions-section" id="submissions">
      <div className="section-heading submissions-heading">
        <div><div className="section-kicker"><span>02</span> SUBMISSIONS</div><h2>Inbox to action</h2></div>
        <p>Review what users send, classify the work, and close the loop without leaving the control room.</p>
      </div>

      <div className="submission-summary" aria-label="Submission totals">
        {summaryItems.map((item) => <div key={item.label}><strong>{compact(item.value)}</strong><span>{item.label}</span></div>)}
      </div>

      <form
        className="submission-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(0);
          setSearch(searchDraft.trim());
        }}
      >
        <label className="submission-search">
          <span className="visually-hidden">Search submissions</span>
          <SearchIcon />
          <input
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="Search descriptions"
            type="search"
            value={searchDraft}
          />
          <button type="submit">Search</button>
        </label>
        <label><span>Type</span><select value={kind} onChange={(event) => { setPage(0); setKind(event.target.value as typeof kind); }}><option value="all">All types</option><option value="feedback">Feedback</option><option value="issue">Bug reports</option></select></label>
        <label><span>Status</span><select value={status} onChange={(event) => { setPage(0); setStatus(event.target.value as typeof status); }}><option value="all">Any status</option><option value="open">Open</option><option value="closed">Closed</option></select></label>
        <label><span>Flag</span><select value={flag} onChange={(event) => { setPage(0); setFlag(event.target.value as typeof flag); }}><option value="all">Any flag</option>{FEEDBACK_FLAG_DEFINITIONS.map((definition) => <option key={definition.id} value={definition.id}>{definition.label}</option>)}</select></label>
      </form>

      <div className="submission-workspace">
        <div className="submission-list" aria-busy={loading}>
          <div className="submission-list-head">
            <span>{loading && !data ? "Loading submissions…" : `${compact(data?.total ?? 0)} matching`}</span>
            {search || kind !== "all" || status !== "all" || flag !== "all" ? <button onClick={() => { setKind("all"); setStatus("all"); setFlag("all"); setSearch(""); setSearchDraft(""); setPage(0); }} type="button">Clear filters</button> : null}
          </div>
          {data?.submissions.length ? data.submissions.map((submission) => (
            <button
              className={`submission-row ${submission._id === selectedId ? "selected" : ""}`}
              key={submission._id}
              onClick={() => setSelectedId(submission._id)}
              type="button"
            >
              <span className={`submission-kind ${submission.kind}`}>{submission.kind === "issue" ? "BUG" : "NOTE"}</span>
              <span className="submission-row-copy"><strong>{submission.description}</strong><small>{relativeTime(submission.createdAt)} · #{submission._id}{submission.contactUsername ? ` · @${submission.contactUsername}` : ""}</small></span>
              <span className={`submission-status ${submission.status}`}><i />{submission.status}</span>
              <span className="submission-row-flags">{submission.flags.slice(0, 2).map((item) => <i key={item}>{feedbackFlagLabel(item)}</i>)}{submission.flags.length > 2 ? <i>+{submission.flags.length - 2}</i> : null}</span>
            </button>
          )) : <div className="submission-empty"><InboxIcon /><strong>No submissions match</strong><span>Try widening the filters or check back after users send something new.</span></div>}
          {pageCount > 1 ? <div className="submission-pagination"><button disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))} type="button">Previous</button><span>Page {page + 1} of {pageCount}</span><button disabled={page + 1 >= pageCount} onClick={() => setPage((current) => current + 1)} type="button">Next</button></div> : null}
        </div>

        {selected ? (
          <FeedbackInspector
            key={`${selected._id}:${selected.updatedAt}`}
            saving={working === selected._id}
            submission={selected}
            onSave={(nextStatus, nextFlags) => void save(selected, nextStatus, nextFlags)}
          />
        ) : <div className="submission-inspector empty"><span>Select a submission to review its details and classification.</span></div>}
      </div>
    </section>
  );
}

function FeedbackInspector({
  submission,
  saving,
  onSave,
}: {
  submission: FeedbackSubmission;
  saving: boolean;
  onSave: (status: FeedbackStatus, flags: FeedbackFlag[]) => void;
}) {
  const [status, setStatus] = useState(submission.status);
  const [flags, setFlags] = useState<FeedbackFlag[]>(submission.flags);
  const groups = [...new Set(FEEDBACK_FLAG_DEFINITIONS.map((definition) => definition.group))];
  const dirty = status !== submission.status ||
    flags.length !== submission.flags.length ||
    flags.some((flag) => !submission.flags.includes(flag));

  const toggleFlag = (flag: FeedbackFlag) => {
    setFlags((current) => current.includes(flag)
      ? current.filter((candidate) => candidate !== flag)
      : [...current, flag]);
  };

  return (
    <article className="submission-inspector">
      <header>
        <div><span className={`submission-kind ${submission.kind}`}>{submission.kind === "issue" ? "BUG REPORT" : "FEEDBACK"}</span><span>#{submission._id}</span></div>
        <time dateTime={new Date(submission.createdAt).toISOString()}>{new Date(submission.createdAt).toLocaleString()}</time>
      </header>
      <p className="submission-description">{submission.description}</p>
      {submission.contactUsername ? (
        <a
          className="submission-contact"
          href={`https://www.twitch.tv/${encodeURIComponent(submission.contactUsername)}`}
          rel="noreferrer"
          target="_blank"
        >
          <span><small>Contact on Twitch</small><strong>@{submission.contactUsername}</strong></span>
          <ArrowIcon />
        </a>
      ) : <p className="submission-contact-empty">No contact username provided.</p>}

      <div className="classification-heading"><div><strong>Status</strong><span>Open is the default for every new submission.</span></div><div className="status-switch"><button aria-pressed={status === "open"} onClick={() => setStatus("open")} type="button">Open</button><button aria-pressed={status === "closed"} onClick={() => setStatus("closed")} type="button">Closed</button></div></div>

      <div className="flag-editor">
        <div className="flag-editor-heading"><strong>Flags</strong><span>{flags.length} selected</span></div>
        {groups.map((group) => {
          const definitions = FEEDBACK_FLAG_DEFINITIONS.filter((definition) =>
            definition.group === group && isFeedbackFlagAllowed(definition.id, submission.kind)
          );
          return <fieldset key={group}><legend>{group}</legend><div>{definitions.map((definition) => <label key={definition.id} className={flags.includes(definition.id) ? "selected" : ""}><input checked={flags.includes(definition.id)} onChange={() => toggleFlag(definition.id)} type="checkbox" /><span>{definition.label}</span></label>)}</div></fieldset>;
        })}
      </div>

      <footer>
        <span>{dirty ? "Unsaved classification changes" : `Updated ${relativeTime(submission.updatedAt)}`}</span>
        <button className="admin-primary" disabled={!dirty || saving} onClick={() => onSave(status, flags)} type="button">{saving ? "Saving…" : "Save classification"}<ArrowIcon /></button>
      </footer>
    </article>
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
        <div><div className="section-kicker"><span>04</span> DATABASE</div><h2>What the archive weighs</h2></div>
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
    <section className="admin-section history-section" id="history">
      <div className="section-heading"><div><div className="section-kicker"><span>05</span> RUN HISTORY</div><h2>Completed work</h2></div></div>
      {history.length ? <div className="history-table">
        <div className="history-head"><span>Operation</span><span>Result</span><span>Processed</span><span>Finished</span></div>
        {history.map((job) => <div className="history-row" key={job._id}><span><strong>{job.title}</strong><small>{job.error ?? job.detail}</small></span><StatusStamp status={job.status} /><span>{compact(job.current)} {job.unit}</span><time>{job.finishedAt ? relativeTime(job.finishedAt) : "—"}</time></div>)}
      </div> : <p className="quiet-empty">The first completed operation will be recorded here.</p>}
    </section>
  );
}

function AuditTrail({ entries }: { entries: Dashboard["auditLog"] }) {
  return (
    <section className="admin-section audit-section" id="audit">
      <div className="section-heading"><div><div className="section-kicker"><span>06</span> AUDIT TRAIL</div><h2>Every privileged action</h2></div></div>
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
  return <header className="auth-masthead"><a href="/"><img alt="" className="admin-seal" src="/brand/twitch-logger-icon-64.png" /><span>Twitch Logger<small>Admin console</small></span></a><span><i />{step}</span></header>;
}

function AuthTelemetry() {
  return (
    <div className="auth-telemetry" aria-hidden="true">
      <div className="telemetry-head"><span>CONTROL PLANE</span><small>READY</small></div>
      <svg viewBox="0 0 560 120" preserveAspectRatio="none"><path className="grid-line" d="M0 20H560M0 60H560M0 100H560M70 0V120M140 0V120M210 0V120M280 0V120M350 0V120M420 0V120M490 0V120" /><path className="signal-line" d="M0 88L28 84L56 87L84 72L112 78L140 67L168 69L196 41L224 61L252 56L280 64L308 48L336 53L364 32L392 47L420 42L448 50L476 23L504 38L532 34L560 29" /><path className="signal-fill" d="M0 88L28 84L56 87L84 72L112 78L140 67L168 69L196 41L224 61L252 56L280 64L308 48L336 53L364 32L392 47L420 42L448 50L476 23L504 38L532 34L560 29V120H0Z" /></svg>
      <div className="telemetry-foot"><span><i />Worker boundary</span><span><i />Encrypted session</span><span><i />Audit enabled</span></div>
    </div>
  );
}

function AuthField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="admin-field"><span>{label}{hint ? <small>{hint}</small> : null}</span>{children}</label>;
}

function InlineError({ children }: { children: ReactNode }) { return <div className="admin-error"><span>!</span>{children}</div>; }
function Freshness({ data }: { data?: Dashboard }) { return <div className="freshness"><i /><span>Live data<small>{data ? `Updated ${relativeTime(data.generatedAt)}` : "Connecting…"}</small></span></div>; }
function StatusStamp({ status, label }: { status: JobStatus; label?: string }) { return <span className={`status-stamp ${status}`}><i />{label ?? humanize(status)}</span>; }

function feedbackFlagLabel(flag: FeedbackFlag) { return FEEDBACK_FLAG_DEFINITIONS.find((definition) => definition.id === flag)?.label ?? humanize(flag); }
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
function InboxIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 5h16v14H4V5Zm0 9h4l2 2h4l2-2h4" /></svg>; }
function SearchIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 5 5" /></svg>; }
function RefreshIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 8.2A7 7 0 0 1 18.8 7M17.9 15.8A7 7 0 0 1 5.2 17" /></svg>; }
