Cerious Systems Win64 Thin Client

This is the local test launcher for the Cerious Systems desktop workflow.

Run:
CeriousSystemsThinClient.cmd

Optional:
CeriousSystemsThinClient.cmd -InstallShortcut

What it does:
1. Finds the local Cerious Systems project root.
2. Starts the same deterministic service launcher used by the toolbar.
3. Opens the terminal in a desktop-style app window with the desktop-client flag.
4. Shows the Cerious Desktop toolbar, which opens individual workspace widgets as floating windows outside the canvas.
5. Uses the same login portal and workspace persistence as the browser portal.

Install layout:
Place this thin-client folder beside the Cerious local application folder, or set this
environment variable before launching:
CERIOUS_SYSTEMS_ROOT=C:\path\to\Cerious local

Future production behavior:
The same thin-client flow will authenticate through the Cerious cloud portal and connect to services running near the exchange data center.
