# SignPath Foundation application

Status: **prepared, not submitted.** Submit after the first public release exists.

- Application form: <https://signpath.org/apply>
- Conditions: <https://signpath.org/terms>
- Project: <https://github.com/SrgAleRin/Nest>
- License: MIT
- Release: <https://github.com/SrgAleRin/Nest/releases/tag/v0.1.0>

## Eligibility checklist

- [x] OSI-approved license (MIT), no commercial dual licensing.
- [x] No proprietary components. Electron, React, xterm, node-pty and other dependencies are open source.
- [x] Actively maintained, public repository.
- [x] A public release exists (required before applying).
- [x] Functionality is documented in the README and on the release page.
- [x] Code signing policy is in the README: <https://github.com/SrgAleRin/Nest#code-signing-policy>
- [x] Privacy policy exists: <https://github.com/SrgAleRin/Nest/blob/main/docs/privacy.md>
- [ ] SignPath account created and organization/project configured.
- [ ] MFA enabled on the GitHub account.
- [ ] Artifact configuration created for the installer and the app executable.

## Signing scope

Artifacts to sign:

1. `apps/desktop/release/win-unpacked/Nest.exe` — the application executable.
2. `apps/desktop/release/Nest-Setup-<version>.exe` — the NSIS installer.

Not signed by this subscription: upstream Electron/Chromium binaries, `node-pty` native modules and other third-party libraries included inside the installer. They remain unsigned upstream artifacts, which the SignPath conditions allow for system libraries and upstream OSS binaries.

## Application text

Use this as the project description in the application:

> Nest is an MIT-licensed Windows desktop application for running multiple command-line coding agents (Claude Code, Codex, OpenCode, DeepSeek Harness, pi, GitHub Copilot CLI) in parallel. Each task gets an isolated git worktree and a real PTY terminal; the app also provides a git diff viewer, review comments and session resume. It is built with Electron and distributed as an NSIS installer via GitHub Releases.
>
> Repository: https://github.com/SrgAleRin/Nest
> License: MIT
> Release: https://github.com/SrgAleRin/Nest/releases/tag/v0.1.0
> CI: GitHub Actions, `.github/workflows/release.yml`
>
> The project currently ships an unsigned installer. SmartScreen warns on first launch, which is the reason for this application. The code signing policy and privacy policy are linked from the README. All release artifacts are built by CI from the tagged commit, and every signing request will be approved manually.
>
> The project is maintained by a single developer. GitHub: https://github.com/SrgAleRin

## After approval

1. Create a SignPath organization and project linked to `SrgAleRin/Nest`.
2. Add a signing policy that requires manual approval, and an artifact configuration covering `Nest.exe` and `Nest-Setup-*.exe`.
3. Store the API token and organization/project/policy/configuration slugs as GitHub Actions secrets.
4. Update the release workflow:
   - build `--dir`, submit `Nest.exe` for signing, then build the NSIS installer from the signed unpacked directory (`electron-builder --prepackaged`), and sign the installer;
   - regenerate `latest.yml` and the `.blockmap` **after** signing, because signing changes the installer hash and size;
   - upload the signed artifacts to the draft GitHub Release.
5. Verify with `Get-AuthenticodeSignature` before publishing the draft.

The publisher shown by Windows will be **SignPath Foundation**, not the individual maintainer. This is expected for certificates issued by the Foundation. If a custom publisher name is required later, use an OV certificate instead.
