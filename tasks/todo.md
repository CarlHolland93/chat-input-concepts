# Portfolio demo and verification

- [x] Add reproducible typecheck, build and preview commands.
- [x] Configure GitHub Pages assets and automated pull-request checks/deployment.
- [x] Put the playground link and prototype scope near the top of the README.
- [x] Verify a clean install, production build and all four concepts in a browser.
- [x] Publish the playground and verify the public URL and repository link.

## Review

- Frozen dependency installation, strict TypeScript validation, production build and diff checks passed locally with Node.js 25.8.2 and pnpm 10.32.1. CI targets Node.js 22.
- Verified the built site under `/chat-input-concepts/`: prompt scoring and send, context trimming from 50% to 34%, intent assumptions, Haiku/Opus routing, and the comparison view. No browser console errors were recorded during the final checks.
- Independent review found no actionable issues in the workflow, asset path or README claims.
- [PR #2](https://github.com/CarlHolland93/chat-input-concepts/pull/2) merged after the Node.js 22 checks passed. [The main workflow](https://github.com/CarlHolland93/chat-input-concepts/actions/runs/36818484770) built and deployed successfully.
- Verified the public playground and comparison view at https://carlholland93.github.io/chat-input-concepts/ with no console errors. The repository About section links to it.
