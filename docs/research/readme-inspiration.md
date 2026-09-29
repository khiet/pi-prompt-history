# Pi extension README inspiration

## Recommendation

Use a short purpose statement, verified installation, a compact usage reference, and visible storage/privacy limitations. Link detailed behavior and verification instead of reproducing the contract. These are editorial recommendations, not an official Pi README standard.

## Sample and popularity evidence

The [npm downloads API](https://api.npmjs.org/downloads/point/2026-08-29:2026-09-27/pi-subagents,pi-mcp-adapter,pi-web-access) reported these downloads for 2026-08-29 through 2026-09-27:

| Package | Downloads | Pi catalog display |
| --- | ---: | --- |
| pi-mcp-adapter | 1,197,959 | 1.2M/mo |
| pi-subagents | 506,599 | 506.6K/mo |
| pi-web-access | 459,058 | 459.1K/mo |

The [official Pi catalog](https://pi.dev/packages) corroborated the rounded counts. Downloads include repeat and automated activity. They establish a high-download sample, not unique users or an ecosystem-wide "most used" ranking. All three samples share an author, limiting stylistic diversity.

## First-party README patterns

- [pi-subagents](https://github.com/nicobailon/pi-subagents/blob/main/README.md): purpose, Install, "Try this first" copyable requests, "How it works," task-oriented tables, troubleshooting, and linked documentation. Borrow immediate onboarding and progressive disclosure.
- [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md): value proposition, "Why This Exists," Install, a "What happens on first run" situation/outcome table, and Quick Start examples. Borrow explicit expectations and behavior tables, not the long configuration inventory.
- [pi-web-access](https://github.com/nicobailon/pi-web-access/blob/main/README.md): capability statement, demos, feature blocks, Install, and optional provider setup. Borrow capability-first framing and required-versus-optional separation, not publication badges or sprawling provider lists.

The structures above are direct observations; recommendations are editorial interpretation. Live README links are mutable.

## Official guidance

[Pi Packages](https://pi.dev/docs/latest/packages) documents local package installation, loading without copying, and personal/project scope. The installed Pi 0.87.1 package and CLI documentation also support `pi -e` for a one-off load and `pi remove` for removal.

For this private, unpublished project, retain the README's tested clone-and-local-install procedure. Do not copy npm commands from published extensions or promote the unverified git-install route.

## Application to the proposals

1. Start with purpose and a working installation, not lifecycle internals.
2. Use exact existing commands and keybindings.
3. Keep plain-text storage, draft replacement, shortcut conflict, and concurrent-rewrite loss visible.
4. Link detailed behavior, release-specific capture caveats, and verification evidence.
5. Compare three voices: Minimal, Reference-first, and Workflow-led. Keep the core facts consistent.

The current repository README is the behavioral source. The proposals link its [source revision](https://github.com/khiet/pi-prompt-history/blob/affad845f86be400dabc6497f853f0483ac2cbe7/README.md) to avoid circular links after a future rewrite. When adopting a proposal, move the detailed reference into `docs/` and update the links.

## Evidence boundaries

No unique-user ranking was established. Existing compatibility claims were not rerun for this documentation task. Research inspected sources manually; automated semantic assessment was unavailable. Search-discovered mirrors and similarly named scoped packages were not used as the selected projects' primary sources.
