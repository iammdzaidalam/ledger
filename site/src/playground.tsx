import { createRoot } from "react-dom/client";
import { PlaygroundApp } from "./app/PlaygroundApp";
import { readInitial } from "./lib/sandbox";
import "./workbench.css";

const root = document.getElementById("app");
if (root) createRoot(root).render(<PlaygroundApp initial={readInitial()} />);
