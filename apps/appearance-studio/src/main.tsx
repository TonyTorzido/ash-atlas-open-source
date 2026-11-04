import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "../../client/src/ui/GameCompactUi.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Appearance Studio root element is missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
