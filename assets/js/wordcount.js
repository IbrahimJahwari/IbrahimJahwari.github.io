// wordcount.js - a word counter for project.html. Does nothing unless the address ends in ?words
// Counts the text inside <main>, skipping charts (svg and .plot) and anything marked .nowords.
// Text in [square brackets] is ignored, so placeholders do not count.
// Mark text with data-wc="prose" (the four topics), "chart" (titles and captions), "ui" (controls).
// Anything else is counted as "other" (headings, links). The syllabus does not say which of these
// count towards the 800 words, so the badge shows prose alone and everything together.
(function () {
  if (!/[?&]words\b/.test(location.search)) return;
  const main = document.querySelector("main");
  if (!main) return;
  const SKIP = "svg,.plot,.nowords,script,style,noscript";
  const words = (t) => (t.replace(/\[[^\]]*\]/g, " ").match(/\S+/g) || []).length;

  const badge = document.createElement("div");
  badge.setAttribute("role", "status");
  badge.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:50;background:#1E2330;color:#fff;" +
    "font:14px/1.45 system-ui,sans-serif;padding:10px 14px;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.3);max-width:280px";
  document.body.appendChild(badge);

  function update() {
    const tally = { prose: 0, chart: 0, ui: 0, other: 0 };
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      if (!p || p.closest(SKIP)) continue;
      const k = p.closest("[data-wc]");
      const key = k && k.dataset.wc in tally ? k.dataset.wc : "other";
      tally[key] += words(n.nodeValue);
    }
    const all = tally.prose + tally.chart + tally.ui + tally.other;
    const over = (v) => (v > 800 ? "#FF9B6B" : "#fff");
    badge.innerHTML =
      `Prose only: <b style="color:${over(tally.prose)}">${tally.prose}</b> of 800<br>` +
      `Prose and chart text: <b style="color:${over(tally.prose + tally.chart)}">${tally.prose + tally.chart}</b><br>` +
      `Everything in main: <b style="color:${over(all)}">${all}</b><br>` +
      `<span style="opacity:.7">Chart text ${tally.chart}, controls ${tally.ui}, headings and links ${tally.other}. Axis labels not counted.</span>`;
  }
  let t;
  new MutationObserver(() => { clearTimeout(t); t = setTimeout(update, 250); })
    .observe(main, { subtree: true, childList: true, characterData: true });
  update();
})();
