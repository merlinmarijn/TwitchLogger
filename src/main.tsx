import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import App from "./App";
import { configurationIssues, convexUrl } from "./runtimeConfig";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

if (!convexUrl) {
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
        <App />
      </ConvexProvider>
    </StrictMode>,
  );
}
