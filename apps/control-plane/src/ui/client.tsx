import "./styles.css";

import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import App from "./app";
import {SetupGate} from './setup';

const Dashboard = lazy(() => import("./dashboard/dashboard"));
const Settings = lazy(() => import("./settings/settings"));

const root = document.getElementById("root");
if (!root) throw new Error("root element is missing");
const dashboard = window.location.pathname === "/dashboard" || window.location.pathname.startsWith("/dashboard/");
const settings = window.location.pathname === "/settings" || window.location.pathname.startsWith("/settings/");
createRoot(root).render(
  <StrictMode>
    {settings ? <Suspense fallback={<div className="dashboard-boot">Opening settings…</div>}><Settings /></Suspense>
      : dashboard ? <Suspense fallback={<div className="dashboard-boot">Opening dashboard…</div>}><Dashboard /></Suspense>
        : <SetupGate><App /></SetupGate>}
  </StrictMode>,
);
