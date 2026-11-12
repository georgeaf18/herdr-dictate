// Dictate: local, live voice-to-text into the focused terminal.
//
// cmd-m (keys.json: global "mod.open:dictate") opens this popup and starts live.py,
// which records the default mic with ffmpeg and transcribes it with parakeet-mlx
// (Parakeet TDT v3 on the GPU, nothing leaves the Mac) while you talk; the popup
// shows the text so far (italics: the sentence that can still change). cmd-m again,
// Space, Enter or the dictate-button mod stops: live.py commits the rest
// and the text is pasted into the terminal that had focus, without
// pressing Enter. Esc cancels. The transcript also stays on the clipboard,
// because pasting goes through it (Herdr has no "type text without Enter" command).
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, TextView } from "gpui-base";
import { exec, run, theme, props, closeOverlay, focused, home, appHome, nextCommand, notify, readTextFile, shared, setShared } from "herdr";

const PYTHON = () => `${home()}/.local/share/uv/tools/parakeet-mlx/bin/python`; // uv tool install parakeet-mlx
const MODEL = "mlx-community/parakeet-tdt-0.6b-v3";
const WORK = () => `${home()}/Library/Caches/herdr-dictate`;
const MAX_MS = 600000; // exec's cap: a recording can't run past 10 minutes
const SHOWN_CHARS = 280; // the popup shows the end of long dictations
// Transcripts are shown as markdown: escape what markdown would act on.
const md = (text) => text.replace(/([\\`*_{}\[\]<>#+|~!-])/g, "\\$1");

export default class Dictate extends View {
  init(_props, cx) {
    this.state = "recording"; // recording | transcribing | error
    this.error = "";
    this.committed = ""; // locked-in text: never changes
    this.open = "";      // the sentence still being heard: can change
    this.target = focused()?.terminal ?? null;
    // Opened by the composer's mic: hand the text back to it (shared "composer.dictated")
    // instead of pasting into the terminal. Only a request from the last few seconds counts.
    const into = shared("dictate.into");
    this.into = into && Date.now() - (into.at ?? 0) < 5000 ? into.mod : null;
    if (into) setShared("dictate.into", null);
    this.startedAt = Date.now();
    this.base = `${WORK()}/rec-${this.startedAt}`;
    // Other mods (dictate-button) see that we're dictating through shared
    // "dictate.terminal", and ask to finish through shared "dictate.finish"
    // (a timestamp newer than our start).
    setShared("dictate.terminal", this.target);
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(150, () => this.handle.focus());
    this.start(cx);
    cx.timer.every(300, (cx) => this.poll(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "stop") this.stop(cx);
        else if (c === "focus") this.handle.focus();
      }
    });
  }

  start(cx) {
    // live.py runs in the background with its pid kept, so stop() can SIGINT it.
    // The exec resolves when it exits; stderr goes to <base>.log.
    // ffmpeg: from PATH, else Homebrew's spots (Apple silicon, then Intel). A missing
    // program ends with a one-line setup hint, which the popup shows.
    const script =
      'ff=$(command -v ffmpeg || for f in /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg; do [ -x "$f" ] && echo "$f" && break; done); ' +
      '[ -n "$ff" ] || { echo "ffmpeg not found. Install it: brew install ffmpeg"; exit 1; }; ' +
      '[ -x "$2" ] || { echo "parakeet-mlx not found. Install it: uv tool install parakeet-mlx --with onnxruntime"; exit 1; }; ' +
      'mkdir -p "$(dirname "$1")" && ' +
      '{ "$2" "$3" "$1" "$ff" "$4" </dev/null >/dev/null 2>"$1.log" & echo $! > "$1.pid"; wait $!; }; ' +
      'code=$?; tail -n 3 "$1.log" 2>/dev/null; exit $code';
    this.process = exec("sh", ["-c", script, "x", this.base, PYTHON(), `${appHome()}/mods/dictate/live.py`, MODEL],
      { timeout: MAX_MS + 60000 });
    cx.spawn(async (cx) => {
      let r;
      try { r = await this.process; } catch (e) { r = { code: 1, stdout: String(e) }; }
      // Ended on its own (not by stop()): the mic failed, access was denied, or a crash.
      if (this.state === "recording") {
        this.fail(cx, (r.stdout || r.stderr || "").trim().split("\n").pop() || "Dictation stopped unexpectedly.");
      }
    });
    // Safety net for exec's cap: stop and keep what was said.
    cx.timer.after(MAX_MS - 5000, (cx) => this.stop(cx));
  }

  poll(cx) {
    if (this.state !== "recording") return;
    if ((shared("dictate.finish") ?? 0) > this.startedAt) return this.stop(cx);
    cx.spawn(async (cx) => {
      let raw;
      try { raw = await readTextFile(`${this.base}.partial`); } catch { return; }
      if (raw === this.partialRaw) return;
      try {
        const { committed, open } = JSON.parse(raw); // live.py: {committed, open}
        this.partialRaw = raw;
        this.committed = committed ?? "";
        this.open = open ?? "";
        cx.notify();
      } catch {}
    });
  }

  stop(cx) {
    if (this.state !== "recording") return;
    this.state = "transcribing";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await exec("sh", ["-c", 'kill -INT "$(cat "$1.pid")" 2>/dev/null; true', "x", this.base]);
        const r = await this.process;
        if (r.code !== 0) return this.fail(cx, (r.stdout || r.stderr || "Transcription failed.").trim().split("\n").pop());
        const text = (await readTextFile(`${this.base}.txt`)).trim();
        this.cleanup();
        if (!text) return this.fail(cx, "Heard nothing.");
        if (this.into === "composer") {
          setShared("composer.dictated", { text, at: Date.now() });
          this.release();
          closeOverlay(props().overlay);
          return;
        }
        await exec("sh", ["-c", 'printf %s "$1" | pbcopy', "x", text]);
        this.release();
        closeOverlay(props().overlay);
        if (this.target) {
          run("pane.focus", { terminal: this.target });
          run("terminal.paste");
        } else {
          notify({ title: "Dictation copied", body: "No terminal was focused; the text is on the clipboard." });
        }
      } catch (e) {
        this.fail(cx, String(e));
      }
    });
  }

  release() {
    if (shared("dictate.terminal") === this.target) setShared("dictate.terminal", null);
  }

  fail(cx, message) {
    this.release();
    this.state = "error";
    this.error = message;
    this.cleanup();
    cx.notify();
  }

  cleanup() {
    const b = this.base;
    exec("rm", ["-f", `${b}.pid`, `${b}.log`, `${b}.partial`, `${b}.partial.tmp`, `${b}.wav`, `${b}.txt`, `${b}.txt.tmp`]).catch(() => {});
  }

  async close() {
    this.release();
    // Esc, or the popup closing any other way: drop the recording (SIGTERM = cancel in live.py).
    if (this.state === "recording") {
      this.state = "cancelled";
      await exec("sh", ["-c", 'kill -TERM "$(cat "$1.pid")" 2>/dev/null; true', "x", this.base]);
      this.cleanup();
    }
  }

  render(cx) {
    const t = theme();
    const title = { recording: "Listening…", transcribing: "Finishing…", error: "Dictation failed" }[this.state] ?? "";
    const hint = this.state === "recording" ? "Space, Enter or ⌘M to insert · Esc to cancel"
      : this.state === "error" ? "Esc to close" : "";
    // Long dictations show their end: trim committed text first, the open sentence last.
    const room = Math.max(0, SHOWN_CHARS - this.open.length);
    const committed = this.committed.length > room ? "…" + this.committed.slice(-room) : this.committed;
    const empty = !this.committed && !this.open;
    const dot = div().w(10).h(10).rounded(5).flex_none()
      .bg(this.state === "transcribing" ? t.working : t.blocked)
      .when(this.state !== "error", (el) => el.loop("opacity", { from: 0.3, to: 1, period: 1000 }));
    return v_flex().id("root").size_full().px(16).py(12).gap(8)
      .bg(t.popover).text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "enter" || e.key === "space" || e.keystroke === "cmd-m") this.stop(cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
      })
      .child(h_flex().gap(10).items_center()
        .child(dot)
        .child(div().flex_1().text_size(13).font_semibold().child(title))
        .when(!!hint, (el) => el.child(div().text_size(12).text_color(t.muted).child(hint)))
        // Done: same as cmd-m / Space / Enter. Primary-button colors, like dictate-button.
        .when(this.state === "recording", (el) => el.child(div()
          .id("dictate-done")
          .w(28).h(24).flex_none().flex().items_center().justify_center().rounded(6)
          .bg(t.solid).text_color(t.solid_foreground)
          .hover((s) => s.opacity(0.85))
          .on_click((_e, cx) => { cx.stop_propagation(); this.stop(cx); })
          .child(svg("mods/dictate/check.svg").size(16)))))
      .child(this.state === "error"
        ? div().flex_1().min_h(0).overflow_hidden().text_size(14).text_color(t.blocked).child(this.error)
        : div().flex_1().min_h(0).overflow_hidden().text_size(14).text_color(empty ? t.dim : t.foreground)
          // One markdown paragraph so the open sentence flows on from the committed
          // text; it's in italics because it can still change.
          .child(empty ? "Start talking…" : TextView.markdown("live",
            [md(committed), this.open && `*${md(this.open)}*`].filter(Boolean).join(" "))));
  }
}
