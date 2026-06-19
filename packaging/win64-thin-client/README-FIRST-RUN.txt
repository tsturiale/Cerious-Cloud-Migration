Cerious Systems Win64 Thin Client

This is the local test launcher for the Cerious Systems desktop workflow.

Run:
CeriousSystemsThinClient.cmd

Optional:
CeriousSystemsThinClient.cmd -InstallShortcut

What it does:
1. Finds the local Cerious Systems project root.
2. Starts the backend services hidden.
3. Opens one Cerious Systems app window.
4. Shuts the local services down automatically when that app window closes.
5. Uses the same login portal and workspace persistence as the browser portal.

Install layout:
Place this thin-client folder beside the Cerious local application folder, or set this
environment variable before launching:
CERIOUS_SYSTEMS_ROOT=C:\path\to\Cerious local

Future production behavior:
The same thin-client flow will authenticate through the Cerious cloud portal and connect to services running near the exchange data center.
