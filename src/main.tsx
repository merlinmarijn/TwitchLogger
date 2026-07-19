import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { configurationIssues, convexUrl } from "./runtimeConfig";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
// eslint-disable-next-line react-refresh/only-export-components
const App = lazy(() => import("./App"));
// eslint-disable-next-line react-refresh/only-export-components
const AdminApp = lazy(() => import("./AdminApp"));
const isAdminRoute = window.location.pathname === "/admin" ||
  window.location.pathname.startsWith("/admin/");

if (isAdminRoute) {
  root.render(
    <StrictMode>
      <Suspense fallback={<main className="route-loader">Opening admin console…</main>}>
        <AdminApp />
      </Suspense>
    </StrictMode>,
  );
} else if (!convexUrl) {
  root.render(
    <StrictMode>
      <main className="setup-required">
        <span className="brand-mark">TL</span>
        <span className="eyebrow">Setup required</span>
        <h1>Twitch Logs is running</h1>
        <p>
          Live logging is paused until the server receives its required environment
          configuration.
        </p>
        {configurationIssues.length > 0 && (
          <ul>
            {configurationIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
        <p className="setup-hint">
          Add the missing values to the container environment and recreate the container.
        </p>
      </main>
    </StrictMode>,
  );
} else {
  const convex = new ConvexReactClient(convexUrl, {
    skipConvexDeploymentUrlCheck: true,
  });
  root.render(
    <StrictMode>
      <ConvexProvider client={convex}>
        <Suspense fallback={<main className="route-loader">Opening Twitch Logs…</main>}>
          <App />
        </Suspense>
      </ConvexProvider>
    </StrictMode>,
  );
}
