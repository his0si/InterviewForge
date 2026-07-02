import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import * as amplitude from "@amplitude/unified";
import { App } from "./App";
import "./index.css";

amplitude.initAll(import.meta.env.VITE_AMPLITUDE_API_KEY, {
  analytics: { autocapture: true },
  sessionReplay: { sampleRate: 1 },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
