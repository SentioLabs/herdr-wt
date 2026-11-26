// Worktrunk dialog: one list of a repo's worktrees, local branches and remote
// branches. Enter opens a worktree or makes one with `wt switch`; ⇥ or a click
// checks worktrees; ⌘⇧⌫ twice removes them with `wt remove`. Started from Herdr's
// shipped `worktree` mod.
// Props, all optional: { space } or { folder, machine } to pick the repo (default:
// the shown space), { branch } to switch to it at once, { tab, argv } for its new space.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, Checkbox, ScrollHandle } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, terminals, exec, home } from "herdr";

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, all = panes()) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

// Home as ~ (git says C:/Users/x where Windows says C:\Users\x).
const tilde = (path, userHome) => {
  const [p, h] = [path, userHome].map((s) => s.replace(/\\/g, "/"));
  return p.startsWith(h) ? `~${p.slice(h.length)}` : path;
};
const ago = (s) => {
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};

// Worktrees, local branches and remote branches from `wt list`. A branch without
// a worktree has no path: choosing it runs `wt switch` on it. `dirty`: the
// worktree has uncommitted changes, which `wt remove` refuses without --force.
async function branches(repo, on) {
  const r = await exec("wt", ["list", "--branches", "--remotes", "--format=json"], { cwd: repo.top, on });
  if (r.code !== 0) throw new Error((r.stderr || "wt list failed.").trim());
  const json = JSON.parse(r.stdout);
  // wt before JSON schema 2 (e.g. v0.61) prints a bare array with path, is_main,
  // working_tree and commit.timestamp on each item, and names remote branches "origin/foo".
  return (Array.isArray(json) ? json : json.items).map((i) => {
    const w = i.worktree?.path ? i.worktree : i.path ? { path: i.path, main: i.is_main, changes: i.working_tree } : null;
    return {
      path: w?.path, branch: i.branch, main: Boolean(w?.main), remote: typeof i.remote === "string" ? i.remote : null,
      at: Date.parse(i.head?.committed_at ?? "") / 1000 || i.commit?.timestamp || 0,
      dirty: Object.entries(w?.changes ?? {}).some(([k, v]) => k !== "diff" && v),
    };
  });
}

// Extra `wt remove` flags for checkout c. wt alone deletes the branch only if
// it's merged, and refuses a worktree with uncommitted changes.
function removeFlags(c) {
  return c.dirty ? ["--force"] : [];
}

// The space showing a checkout: its first terminal is in it (the deepest checkout wins).
function spaceOf(path, all, on, spaceList, paneList) {
  const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
  return spaceList.find((s) => (s.machine ?? null) === (on ?? null) && (() => {
    const at = place(s, paneList)?.replace(/\\/g, "/");
    if (!at || !inside(at, path)) return false;
    return !all.some((c) => c.path !== path && c.path.length > path.length && inside(at, c.path));
  })());
}

async function git(cwd, args, on) {
  const r = await exec("git", args, { cwd, on });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

// The repo a folder belongs to: its main checkout and name. null outside git.
async function repoOf(folder, on) {
  const top = await git(folder, ["rev-parse", "--show-toplevel"], on);
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
  if (!top.ok || !common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  // A bare repo hidden beside its worktrees (<project>/.bare) is named after its project.
  const parts = main.split("/"), name = parts.at(-1) === ".bare" ? parts.at(-2) : parts.at(-1);
  return { top: top.out, main, name };
}

// Close space s and wait for its programs to stop. space.close only queues the
// kills, so an agent or build still writing into the folder would race the
// removal. Returns false if they're still running after 10 seconds.
async function closeSpace(s, cx) {
  const tabs = new Set((s.tabs ?? []).map((t) => t.id));
  const closing = new Set(panes().filter((p) => p.terminal && tabs.has(p.tab)).map((p) => p.terminal));
  run("space.close", { id: s.id, confirmed: true });
  const deadline = Date.now() + 10_000;
  while (closing.size && terminals().some((t) => t.state === "live" && closing.has(t.address))) {
    if (Date.now() >= deadline) return false;
    await cx.sleep(50);
  }
  return true;
}

export default class Worktrees extends View {
  init(_props, cx) {
    this.on = this.space()?.machine;
    this.userHome = this.on ? null : home();
    this.text = props()?.branch ?? "";
    this.list = undefined; // the rows, once read
    this.at = 0;
    this.confirm = null; // the checkouts armed for removal: a second ⌘⇧⌫ removes them
    this.picked = new Set(); // paths of the checked worktrees
    this.scroll = ScrollHandle.new();
    this.input = InputState.new({ value: this.text, placeholder: "filter worktrees" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.error = ""; this.at = 0; this.confirm = null; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.go(cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.busy = false;
    this.error = "";
    this.repo = undefined; // undefined: looking, null: not in git
    this.handle = cx.focus_handle();
    this.handle.focus(); // the root is mounted from the first frame: keep the keyboard here while loading
    cx.spawn(async (cx) => {
      try {
        if (this.on) {
          let result;
          try { result = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on }); } catch {}
          if (!result || result.code !== 0 || !result.stdout.trim()) result = await exec("powershell.exe", ["-NoProfile", "-Command", "[Console]::Write($HOME)"], { on: this.on });
          if (result.code !== 0 || !result.stdout.trim()) throw new Error("Could not find the remote home folder.");
          this.userHome = result.stdout.trim().replace(/\\/g, "/");
        }
        this.folder = props()?.folder || place(this.space()) || panes().find((p) => p.focused)?.cwd || this.userHome;
        const repo = await repoOf(this.folder, this.on);
        if (repo) this.list = await branches(repo, this.on);
        this.repo = repo;
        cx.notify();
        // The input mounts only once loading is done. A focus call made earlier lands on nothing.
        cx.timer.after(100, () => this.input.focus());
        if (props()?.branch) await this.work(cx);
      } catch (error) { this.repo = null; this.error = String(error); cx.notify(); }
    });
  }

  space() {
    const p = props() ?? {};
    // A key binding passes no props: use the shown space, so remote spaces exec on their machine.
    return spaces().find((s) => s.id === p.space) ?? (p.folder ? { folder: p.folder, machine: p.machine ?? null, name: "" } : spaces().find((s) => s.active));
  }

  close() {
    closeOverlay(props().overlay);
  }

  go(cx) {
    if (this.busy || !this.repo) return;
    cx.spawn(async (cx) => this.work(cx));
  }

  async work(cx) {
    if (this.busy || !this.repo) return;
    this.busy = true;
    this.busyText = `wt switch ${this.text.trim()}…`;
    this.error = "";
    cx.notify();
    try { this.error = await this.create(); }
    catch (error) { this.error = String(error); }
    this.busy = false;
    if (!this.error) this.close();
    cx.notify();
  }

  // worktrunk picks the path (worktree-path in ~/.config/worktrunk/config.toml) and runs
  // its hooks. --yes: there's no terminal to answer hook approval prompts.
  async create() {
    const branch = this.text.trim();
    if (!branch) return "Type a branch name.";
    if (branch.startsWith("-")) return "A branch name can't start with -."; // wt would read it as a flag
    // wt switch on a remote-only branch makes a local one tracking it.
    const refs = await git(this.repo.main, ["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`, `refs/remotes/*/${branch}`, `refs/remotes/${branch}`], this.on);
    const exists = refs.ok && refs.out !== "";
    const sw = await exec("wt", ["switch", ...(exists ? [] : ["--create"]), branch, "--no-cd", "--yes"], { cwd: this.repo.top, on: this.on });
    if (sw.code !== 0) return (sw.stderr || sw.stdout || "wt switch failed.").trim();
    // Switching to "origin/foo" makes a worktree for local "foo".
    const made = (await branches(this.repo, this.on)).filter((c) => c.path);
    const path = (made.find((c) => c.branch === branch) ?? made.find((c) => branch.endsWith(`/${c.branch}`)))?.path;
    if (!path) return `wt switch made ${branch} but wt list doesn't show its worktree.`;
    const p = props() ?? {};
    // Leave spaces unnamed so they follow the checkout folder and nest under the repo.
    run("space.new", { folder: path, machine: this.on, tab: p.tab, argv: p.argv });
    return "";
  }

  // Enter in the picker. `typed` is the trimmed filter text, `rows` what items() lists,
  // `at` the highlighted row. An exact branch name wins over the highlight.
  // Returns { open: checkout }, { create: "branch" } or null.
  choose(typed, rows, at) {
    const pick = (c) => (c.path ? { open: c } : { create: c.create ?? c.branch });
    const exact = rows.find((c) => c.branch === typed);
    if (exact) return pick(exact);
    return rows[at] ? pick(rows[at]) : null;
  }

  submit(cx) {
    const pick = this.choose(this.text.trim(), this.items(), this.at);
    if (pick?.open) return this.open(pick.open);
    if (pick?.create) { this.text = pick.create; this.go(cx); }
  }

  // The matching rows, then a "Create" row unless the text names a branch exactly.
  items() {
    const typed = this.text.trim();
    const rows = this.shown();
    return typed && !rows.some((c) => c.branch === typed) ? [...rows, { create: typed }] : rows;
  }

  shown() {
    const f = this.text.trim().toLowerCase();
    return (this.list ?? []).filter((c) => !f || `${c.branch ?? ""} ${c.path ?? ""}`.toLowerCase().includes(f));
  }

  open(c) {
    if (!c) return;
    this.close();
    const s = spaceOf(c.path, this.list, this.on, spaces(), panes());
    if (s) run("space.select", { id: s.id });
    else run("space.new", { folder: c.path, machine: this.on });
  }

  // Only linked worktrees can be checked or removed: not branches, not the main checkout.
  removable(c) {
    return Boolean(c?.path && !c.main);
  }

  toggle(c) {
    if (!this.removable(c)) return;
    if (this.picked.has(c.path)) this.picked.delete(c.path);
    else this.picked.add(c.path);
    this.confirm = null;
  }

  // ⌘⇧⌫ removes the checked worktrees, or the highlighted one when none is checked.
  // The first press arms them, the second removes them.
  armRemove(cx) {
    const targets = this.picked.size ? this.list.filter((c) => this.picked.has(c.path)) : [this.items()[this.at]].filter((c) => this.removable(c));
    if (this.busy || !targets.length) return;
    const same = this.confirm && this.confirm.map((c) => c.path).join("\n") === targets.map((c) => c.path).join("\n");
    if (same) cx.spawn(async (cx) => this.drop(targets, cx));
    else this.confirm = targets;
  }

  // `wt remove` each one so worktrunk's hooks run, then the list again. The dialog stays open.
  async drop(targets, cx) {
    this.busy = true;
    this.error = "";
    const failed = [];
    for (const c of targets) {
      this.busyText = `wt remove ${c.branch ?? c.path}…`;
      cx.notify();
      try {
        // Terminals first: a shell sitting in the folder keeps it busy on Windows.
        const s = spaceOf(c.path, this.list.filter((x) => x.path), this.on, spaces(), panes());
        if (s && !(await closeSpace(s, cx))) {
          failed.push(`${c.branch ?? c.path}: its space's terminals haven't stopped yet. Remove again to retry.`);
          continue;
        }
        if (c.path === this.repo.top) this.repo.top = this.repo.main; // later wt calls can't run in a deleted folder
        const r = await exec("wt", ["remove", c.branch ?? c.path, "--foreground", "--yes", ...removeFlags(c)], { cwd: this.repo.main, on: this.on });
        if (r.code !== 0) failed.push(`${c.branch ?? c.path}: ${(r.stderr || r.stdout || "wt remove failed.").trim()}`);
      } catch (error) { failed.push(`${c.branch ?? c.path}: ${error}`); }
    }
    try { this.list = await branches(this.repo, this.on); } catch (error) { failed.push(String(error)); }
    // Worktrees that failed to go stay checked.
    this.picked = new Set(this.list.filter((c) => c.path && this.picked.has(c.path)).map((c) => c.path));
    this.error = failed.join("\n");
    this.busy = false;
    this.confirm = null;
    this.at = 0;
    cx.notify();
  }

  key(e, cx) {
    if (e.key === "escape") {
      if (!this.confirm) return this.close();
      this.confirm = null;
      return cx.notify();
    }
    const n = this.items().length;
    if (e.key === "enter") this.submit(cx);
    else if ((e.key === "down" || e.key === "up") && n) { this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n; this.scroll.scroll_to_item(this.at); }
    else if (e.keystroke === "tab") this.toggle(this.items()[this.at]);
    else if (e.keystroke === "cmd-shift-backspace") this.armRemove(cx); // cmd-backspace usually clears the terminal line
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  render() {
    const t = theme();
    const r = this.repo;
    const rows = this.items();
    const matched = this.shown().length;
    const all = this.list ?? [];
    const spaceList = spaces();
    const paneList = panes();
    const createRow = (c, i) =>
      h_flex()
        .id(`wt-${i}`)
        .flex_none()
        .h(44)
        .px(10)
        .gap(8)
        .items_center()
        .rounded(7)
        .cursor_pointer()
        .when(i === this.at, (el) => el.bg(t.selected))
        .when(i !== this.at, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { this.at = i; this.submit(cx); })
        .child(div().flex_none().w(16).text_color(t.accent).child("+"))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(`Create ${c.create}`))
        .child(div().flex_none().text_size(11).text_color(t.dim).child("wt switch -c"));
    const row = (c, i) => {
      if (c.create) return createRow(c, i);
      const on = i === this.at;
      const there = c.path && spaceOf(c.path, all.filter((x) => x.path), this.on, spaceList, paneList);
      const picked = this.picked.has(c.path);
      const armed = Boolean(this.confirm?.some((x) => x.path === c.path));
      const box = this.removable(c)
        ? Checkbox.new(`wt-pick-${i}`)
            .checked(picked)
            .on_change((_checked, cx) => { this.toggle(c); cx.notify(); })
            .flex_none()
            .size(16)
            .rounded(4)
            .border(1)
            .border_color(picked ? t.accent : t.dim)
            .when(picked, (el) => el.bg(t.accent))
            .items_center()
            .justify_center()
            .child(picked ? div().text_size(11).text_color(t.background).child("\u2713") : div())
        : div().flex_none().w(16);
      return h_flex()
        .id(`wt-${i}`)
        .flex_none()
        .h(44)
        .px(10)
        .gap(10)
        .items_center()
        .rounded(7)
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .child(box)
        // The open click sits beside the checkbox, not around it, so checking never opens.
        .child(v_flex().id(`wt-open-${i}`).flex_1().min_w(0).h_full().justify_center().cursor_pointer().on_click(() => this.open(c)).child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.branch ?? "detached"))
            .when(c.main, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("main checkout")))
            .when(Boolean(there), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("open")))
            .when(c.dirty, (el) => el.child(div().flex_none().text_size(11).text_color(t.muted).child("changes")))
            .when(!there && c.at > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(c.at)))),
        )
        .child(div().truncate().text_size(11.5).text_color(armed ? t.blocked : t.dim).child(c.path ? tilde(c.path, this.userHome ?? "") : `${c.remote ? `${c.remote} \u00b7 ` : ""}no worktree yet`)));
    };
    const count = matched === all.length ? `${all.length} branches` : `${matched}/${all.length} branches`;
    return v_flex()
      .id("worktrees")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().child(div().flex_1().font_semibold().text_color(t.foreground).child(`Worktrees${r ? ` of ${r.name}` : ""}`)).child(div().text_size(11).text_color(t.dim).child(r ? count : "")))
      .when(r === undefined || (r && this.list === undefined), (el) => el.child(div().text_color(t.muted).child("\u2026")))
      .when(r === null, (el) => el.child(div().text_color(t.muted).child(`${this.folder ? tilde(this.folder, this.userHome ?? "") : "This folder"} is not in a git repository.`)))
      .when(Boolean(r && this.list), (el) =>
        el
          .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
          .child(
            div()
              .relative()
              .flex_1()
              .min_h(0)
              .child(
                v_flex()
                  .id("wt-list")
                  .track_scroll(this.scroll)
                  .size_full()
                  .overflow_y_scroll()
                  .children(rows.map(row))
                  .when(rows.length === 0, (el) => el.child(div().p(10).text_color(t.dim).child("No matching worktrees."))),
              )
              .child(Scrollbar.vertical("wt-list").absolute().inset_0()),
          ),
      )
      .when(Boolean(this.confirm) && !this.busy, (el) => {
        const n = this.confirm.length;
        const dirty = this.confirm.filter((c) => c.dirty).length;
        return el.child(div().text_color(t.blocked).child(`Remove ${n === 1 ? (this.confirm[0].branch ?? "this worktree") : `${n} worktrees`}${dirty ? `, losing uncommitted changes in ${dirty}` : ""}? \u2318\u21e7\u232b again removes \u00b7 esc keeps`));
      })
      .when(this.busy, (el) => el.child(div().text_color(t.muted).child(this.busyText)))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child("\u2191\u2193 choose \u00b7 \u21e5 check \u00b7 \u21b5 open or create \u00b7 \u2318\u21e7\u232b remove \u00b7 esc close"));
  }
}
