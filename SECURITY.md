# Security policy

Track Extract is pre-release software. Security reports should be submitted through GitHub's private vulnerability
reporting flow for this repository rather than a public issue. Include affected versions, reproduction steps, impact,
and any suggested mitigation.

## Dependency policy

- npm dependencies are audited in CI and Dependabot checks npm, Cargo, pip, and GitHub Actions weekly.
- Direct model downloads are limited to approved HTTPS GitHub hosts, bounded by configured and absolute size limits,
  and support SHA-256 verification when the upstream publisher provides a digest.
- `RUSTSEC-2024-0429` is temporarily ignored by the Cargo audit gate. It is a `glib::VariantStrIter` API unsoundness
  advisory inherited through Tauri's Linux GTK stack. Track Extract does not use that API, and Tauri 2.11 currently
  resolves `glib` 0.18. Remove this exception as soon as Tauri's Linux stack resolves `glib` 0.20 or newer.

Never include private audio, model credentials, access tokens, or local filesystem paths in a report unless they are
essential to reproduce the issue.
