# Privacy policy

Nest is a local desktop application for running command-line coding agents. This policy describes what Nest stores and what network requests it makes.

## Data Nest stores

Nest keeps its data on the local machine, in the Electron user data directory:

```text
%APPDATA%\Nest\nest.db
```

The SQLite database contains:

- paths and names of projects you add;
- tasks, branches and worktree paths;
- harness/session metadata and terminal scrollback;
- review comments and application settings.

Nest does not create an account and does not upload this database anywhere.

## Network requests

Nest itself makes the following network requests:

- **Update checks.** Nest checks for updates by default in packaged builds: 20 seconds after launch and every six hours. With an empty **Settings → Updates → Update feed** the request goes to the built-in GitHub Releases feed; a saved URL (or `NEST_UPDATE_URL`) replaces it. Each request fetches `latest.yml` from that feed and contains no personal data beyond ordinary HTTP metadata (IP address, user agent, timestamp), which is processed by the feed host. The switch in Settings → Updates turns checks off completely: no request is made, a run in flight is cancelled and a downloaded installer is dropped.
- **Git operations.** Fetch, push and other git commands contact the remotes configured in your repository. These operations are initiated by you.

Nest does not include telemetry, analytics, crash reporting, advertising or cloud sync.

## Coding agents

Claude Code, Codex, DeepSeek Harness, OpenCode, pi, GitHub Copilot CLI and custom commands are separate programs launched in a terminal. Nest passes your input to those programs and displays their output, but it does not proxy or inspect their network traffic. Anything you send to an agent is handled by that agent and its provider under their own terms and privacy policy.

## Removing your data

Uninstalling Nest does not delete `%APPDATA%\Nest`; projects, settings and session history remain. Delete that directory manually to remove all locally stored data.

## Contact

Questions and reports: [GitHub Issues](https://github.com/SrgAleRin/Nest/issues).
