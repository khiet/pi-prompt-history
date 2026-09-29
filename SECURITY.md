# Security

Report a vulnerability privately with GitHub's [Report a vulnerability](https://github.com/khiet/pi-prompt-history/security/advisories/new) form. Do not open a public issue, and do not include real prompt history or secrets in the report.

This is a best-effort personal project: there is no response-time commitment, and only the latest `main` is supported.

The extension stores typed prompts in plain text by design; see the README's [Privacy](README.md#privacy-what-loading-this-extension-changes) section. That storage is documented behavior, not a vulnerability, but a way for the history file to leak beyond it (to the model, to logs, or to other users) is.
