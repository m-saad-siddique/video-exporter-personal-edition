# Contributing

Thanks for helping improve Video Exporter — Personal Edition.

## Start with an issue

Use the bug or feature-request templates for a reproducible problem or a proposed improvement. For questions and design discussion, use the repository's Discussions tab. Keep reports focused and respectful, following [the community conduct guidelines](CODE_OF_CONDUCT.md).

Include the browser and extension versions, steps to reproduce, expected behavior, and actual behavior. Synthetic/public test media and reviewed, redacted diagnostics are useful; private video links and authentication data are not needed.

## Local development

1. Fork the repository and create a branch from `main`.
2. Load the folder containing `manifest.json` through **Load unpacked** in `chrome://extensions`.
3. After changes, reload the extension and any test pages that were already open.
4. Run `node --test tests/regressions.test.cjs` with Node.js 18 or newer.
5. For UI or download-lifecycle changes, also run the optional browser check described in the README when Chromium is available.

The ordinary regression suite has no external dependencies. Use synthetic fixtures rather than downloaded course or customer content.

## Changes and validation

- Match the existing JavaScript style and keep changes focused on one problem.
- Add meaningful regression coverage for bugs or behavior changes. Pure copy/style changes usually need an appropriate visual or manual check instead.
- Include screenshots for UI changes, explaining when they use test data.
- Keep required licenses and copyright notices intact.
- For a bundled dependency update, record its pinned version, source, and verified hash, and run the media regressions.
- Do not commit generated exports, browser profiles, `.env` files, or credentials.

## Pull requests

Explain the user-visible problem, the resulting behavior, and how you validated it. Link an existing issue when relevant. Address review comments before merging.

`main` is protected: pull requests need a passing **Regression tests** check, an up-to-date branch, resolved conversations, and linear history. Administrators are included. Do not bypass those requirements or push directly to `main`.

The repository uses a solo-maintainer policy: an external approving review is not mandatory, but all pull requests must pass the required checks before merging. Force pushes and branch deletion on `main` are blocked. Reviews are still welcome for substantive changes.
