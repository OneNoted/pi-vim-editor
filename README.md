# pi-vim-editor

A Vim-style modal editor extension for [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

Repository: <https://github.com/OneNoted/pi-vim-editor>

## Features

Current feature set:

- normal / insert / visual / visual-line modes
- counts
- motions: `h`, `j`, `k`, `l`, `w`, `b`, `e`, `ge`, `0`, `^`, `$`, `gg`, `G`
- find motions: `f`, `F`, `t`, `T`, `;`, `,`
- operators: `d`, `c`, `y`
- common commands: `x`, `X`, `s`, `S`, `D`, `C`, `Y`, `p`, `P`, `u`
- text objects: `iw`, `aw`
- visual selection rendering
- mode label in the editor border

## Install

### Try without installing

```bash
pi -e /path/to/pi-vim-editor
```

### Install from a local path

```bash
pi install /path/to/pi-vim-editor
```

### Install from npm

```bash
pi install npm:pi-vim-editor
```

## Development

Typecheck and run the local crash/smoke suite with Bun:

```bash
bun install
bun run typecheck
./scripts/smoke.sh
```

To preview the published tarball contents:

```bash
bun run pack:dry-run
```

## Publish

```bash
bunx npm login
bun publish --access public
```

`bun publish --dry-run` still checks auth, so `bun run pack:dry-run` is the easiest local packaging check before publishing.

## Safety / failure mode

This extension currently relies on pi editor internals to implement modal rendering and behavior.

To reduce host breakage while iterating, it includes a failsafe mode:

- if modal handling throws, it logs once
- it falls back to the built-in editor behavior for the rest of the session
- the mode label shows `SAFE`

## Current limitations

This is already usable, but it is still aiming for tighter Vim parity in areas like:

- exact text object semantics
- some edge cases around wrapped lines and empty lines
- perfect paste behavior in all linewise/charwise combinations
- long-term compatibility with future pi internal editor changes

## Packaging notes

This package follows pi package conventions via the `pi` key in `package.json` and is tagged with the `pi-package` keyword for discoverability.
