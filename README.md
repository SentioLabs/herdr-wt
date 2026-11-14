# herdr-wt

A [Herdr](https://herdr.dev) mod: one dialog to open, create and remove git worktrees with [worktrunk](https://github.com/max-sixty/worktrunk). Press ⌘⇧G in any space, local or on another machine.

![Worktrees dialog](preview.png)

## Install

Ask your agent to install it from this repo, or by hand:

1. Copy `mods/wt/` into `~/.config/herdr-app/mods/` (rename it if you already have a `wt` mod, and change the key to match).
2. Merge `keys.json` into `~/.config/herdr-app/keys.json`.
3. Run `herdr-app check ~/.config/herdr-app/mods/wt`.

It needs `git` and `wt` on every machine you use it with. It approves worktrunk's hook prompts (`--yes`) because there's no terminal to answer them.

[RECIPE.md](RECIPE.md) describes the mod in enough detail to rebuild it on another Herdr version.
