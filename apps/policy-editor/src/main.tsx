import "./shims/buffer.ts";
import "./index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { openPolicies } from "./policy/remote.ts";

const root = document.getElementById("root");
if (root === null) throw new Error("The page has no #root element.");
const initialOpen = openPolicies(new URLSearchParams(window.location.search).get("policy"));
createRoot(root).render(
  <StrictMode>
    <App initialOpen={initialOpen} />
  </StrictMode>,
);
