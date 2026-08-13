import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Conductor design system (global, class-based) + token bridge for reused content components.
import "./ui/conductor-wirekit.css";
import "./ui/conductor-conversation.css";
import "./ui/conductor-flightdeck.css";
import "./ui/conductor-aliases.css";
import "./ui/conductor-markdown-modes.css";
import "./ui/conductor-fleet.css";
// The CRM's status palette — one definition for every surface that paints a TOSSE status.
import "./ui/tosse-status.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
