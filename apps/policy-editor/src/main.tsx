import "./shims/buffer.ts";
import "@fontsource-variable/inter";
import "./index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { loadRemotePolicy } from "./policy/remote.ts";

const root = document.getElementById("root");
if (root === null) throw new Error("The page has no #root element.");
const initial = await loadRemotePolicy();
createRoot(root).render(
  <StrictMode>
    <App initial={initial} />
  </StrictMode>,
);
