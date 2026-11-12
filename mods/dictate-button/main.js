// A floating mic button for the `dictate` mod, placed by the layout
// (layouts/main-mic.json: "floating" on the "main" block, bottom right).
// Click: dictate into the focused pane. While dictating (shared "dictate.terminal"),
// it pulses red; click again to finish (shared "dictate.finish", which the
// dictate popup watches).
import { View, div, svg } from "gpui-kit";
import { run, theme, shared, setShared } from "herdr";

export default class DictateButton extends View {
  render(cx) {
    const t = theme();
    const live = Boolean(shared("dictate.terminal"));
    // Herdr draws the floating frame around this and pads it 5 px above and below
    // only; the 5 px side padding here makes that an even border around the button.
    // (The frame can't be removed or recolored on a floating block.)
    return div()
      .id("dictate-button")
      .px(5)
      .child(div()
        .id("dictate-button-face")
        .w(44)
        .h(34)
        .flex()
        .items_center()
        .justify_center()
        .rounded(7)
        // Idle: the theme's primary-button colors. Recording: red, pulsing.
        .bg(live ? t.blocked : t.solid)
        .text_color(live ? "#ffffff" : t.solid_foreground)
        .when(live, (el) => el.loop("opacity", { from: 0.55, to: 1, period: 1000 }))
        .hover((s) => s.opacity(0.85))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          if (live) setShared("dictate.finish", Date.now());
          else run("mod.open", { name: "dictate" });
        })
        .child(svg("mods/dictate-button/mic.svg").size(20)));
  }
}
