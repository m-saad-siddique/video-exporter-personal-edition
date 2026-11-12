# Security

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/m-saad-siddique/video-exporter-personal-edition/security/advisories/new) for security issues. Avoid opening a public issue that exposes a vulnerability, private media URL, token, cookie, credential, or personal data.

Include the extension/browser versions, affected component, impact, and reproducible steps. Prefer synthetic media or a minimal test page. Review diagnostic files before attaching them: URL redaction is helpful but is not a guarantee that every identifier has been removed.

For ordinary playback, download, or transcript bugs without a security impact, use the public bug-report template.

## Scope

Relevant reports include unintended credential or media disclosure, unsafe page-to-extension communication, unexpected privileged requests, and vulnerabilities introduced by bundled dependencies.

The extension does not implement DRM decryption or authentication bypass. Required third-party licenses and the pinned remuxer provenance are included in `vendor/`.
