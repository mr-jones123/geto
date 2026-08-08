import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTools } from "./src/tools.ts";
import { registerCommand } from "./src/command.ts";

export default function (pi: ExtensionAPI) {
  registerTools(pi);
  registerCommand(pi);
}
