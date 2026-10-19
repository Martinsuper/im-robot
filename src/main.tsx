import { initializePersistentState } from "./lib/persistentState";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

void initializePersistentState().then(() =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  ),
);
