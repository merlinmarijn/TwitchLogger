import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import App from "./App";
import { convexUrl } from "./runtimeConfig";
import "./styles.css";

if (!convexUrl) {
  throw new Error("CONVEX_URL is required at runtime (or VITE_CONVEX_URL in local development).");
}
const convex = new ConvexReactClient(convexUrl);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  </StrictMode>,
);
