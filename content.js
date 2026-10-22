// BasedPL Input — content script.
// Uses the real engine from vendor/input.js (AnswerDotAI/basedpl's python/basedpl/input.js,
// vendored verbatim: press/reset for Option chords, matches/entry/bplStart/inCode for the
// `name backtick-completion), the symbol bar and editor-insertion technique from
// python/basedpl/lb.js, and drops lb.js's Jupyter-cell `%%bpl`/`%bpl` region detection (here,
// any editable field the extension is enabled on counts as "BPL code").
(() => {
  'use strict';

  let input = null; // {matches, inCode, bplStart, entry, press, reset}, set once loaded below.
  let chordPending = false; // mirrors input.js's internal `pending`, which isn't exposed to us.
  let layoutData = null, symbolsData = null; // kept around (beyond what `input` needs) to build the symbol bar.

  async function loadInput() {
    const [layout, symbols] = await Promise.all([
      fetch(chrome.runtime.getURL('vendor/layout.json')).then(r => r.json()),
      fetch(chrome.runtime.getURL('vendor/symbols.json')).then(r => r.json())
    ]);
    layoutData = layout; symbolsData = symbols;
    input = self.__basedplInputFactory(symbols, layout);
    buildBar();
    applyBarVisibility();
  }
  const ready = loadInput();

  // ---- Editor adapters: {id, text, pos, empty, bpl, rect(), insert(text, from?)}. ----
  //
  // The contenteditable branch deliberately does NOT read CodeMirror's `cmView`/`cmTile`
  // (or any other editor-specific instance a page attaches to its own DOM nodes): content
  // scripts run in an isolated JS world with their own wrapper object per DOM node, so a
  // plain property a page assigns on its wrapper (`el.cmView = view`) is invisible on ours,
  // even for the identical underlying element. Verified directly: reading
  // `document.activeElement.cmView` from the page's own console returns the EditorView, the
  // same read from this content script returns undefined.
  //
  // Instead, everything below works off standard DOM Selection/Range APIs, which ARE shared
  // across worlds (they reflect genuine document/selection state, not page-JS expandos). This
  // also means it generalizes to any contenteditable editor (CodeMirror, ProseMirror, Gmail
  // compose, ...) with no editor-specific integration needed.
  function textareaRect(t) {
    const d = document;
    const mirror = d.createElement('div'), caret = d.createElement('span'), css = getComputedStyle(t), rect = t.getBoundingClientRect();
    for (const p of ['font', 'lineHeight', 'letterSpacing', 'padding', 'border', 'boxSizing', 'width', 'tabSize']) mirror.style[p] = css[p];
    Object.assign(mirror.style, {position: 'fixed', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
      left: `${rect.left - t.scrollLeft}px`, top: `${rect.top - t.scrollTop}px`});
    mirror.textContent = t.value.slice(0, t.selectionStart);
    caret.textContent = '​';
    mirror.append(caret);
    d.body.append(mirror);
    const result = caret.getBoundingClientRect();
    mirror.remove();
    return result;
  }

  // ---- Generic contenteditable support via Selection/Range (see note above). ----
  // "Lines" = direct children of the editable root that are themselves elements (CodeMirror's
  // one `div.cm-line` per line, or a plain editable div with one child per line); within a line,
  // content is assumed flat/inline, so native Range.toString()/TreeWalker suffice there.
  function editableRoot(el) {
    if (!el?.isContentEditable) return null;
    let root = el;
    while (root.parentElement?.isContentEditable) root = root.parentElement;
    return root;
  }
  function lineLength(line) {
    return line.nodeType === Node.TEXT_NODE ? line.nodeValue.length : line.textContent.length;
  }
  function serializeEditable(root) {
    const lines = [...root.childNodes];
    if (!lines.length) return root.textContent || '';
    return lines.map(n => (n.nodeType === Node.TEXT_NODE ? n.nodeValue : n.textContent)).join('\n');
  }
  function offsetInEditable(root, node, nodeOffset) {
    if (node == null) return 0;
    const lines = [...root.childNodes];
    let total = 0;
    for (const line of lines) {
      if (line === node) {
        let sub = 0;
        for (let j = 0; j < nodeOffset && j < line.childNodes.length; j++) sub += lineLength(line.childNodes[j]);
        return total + sub;
      }
      if (line === node.parentNode || (node.nodeType === Node.TEXT_NODE && line.contains(node))) {
        const r = document.createRange();
        r.selectNodeContents(line);
        try { r.setEnd(node, nodeOffset); } catch { return total; }
        return total + r.toString().length;
      }
      total += lineLength(line) + 1; // +1 for the inferred '\n' between lines
    }
    return total;
  }
  function positionInEditable(root, offset) {
    const lines = [...root.childNodes];
    let remaining = offset;
    for (const line of lines) {
      const len = lineLength(line);
      if (remaining <= len) {
        if (line.nodeType === Node.TEXT_NODE) return {node: line, offset: remaining};
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let node, acc = 0;
        while ((node = walker.nextNode())) {
          if (remaining <= acc + node.nodeValue.length) return {node, offset: remaining - acc};
          acc += node.nodeValue.length;
        }
        return {node: line, offset: line.childNodes.length};
      }
      remaining -= len + 1;
    }
    const last = lines[lines.length - 1];
    if (!last) return {node: root, offset: 0};
    return last.nodeType === Node.TEXT_NODE ? {node: last, offset: last.nodeValue.length} : {node: last, offset: last.childNodes.length};
  }

  function editor(target) {
    const m = window.monaco?.editor?.getEditors?.().find(e => e.hasTextFocus());
    if (m) {
      const model = m.getModel();
      if (!model || m.getOption?.(window.monaco.editor.EditorOption.readOnly)) return null;
      const p = m.getPosition(), selection = m.getSelection();
      return {
        id: m, text: model.getValue(), pos: model.getOffsetAt(p), empty: selection.isEmpty(), bpl: true,
        rect() {
          const r = m.getDomNode().getBoundingClientRect(), c = m.getScrolledVisiblePosition(p);
          return {left: r.left + c.left, bottom: r.top + c.top + c.height};
        },
        insert(text, from = model.getOffsetAt(selection.getStartPosition())) {
          const a = model.getPositionAt(from), b = selection.getEndPosition();
          m.pushUndoStop();
          m.executeEdits('basedpl-ext', [{range: {startLineNumber: a.lineNumber, startColumn: a.column,
            endLineNumber: b.lineNumber, endColumn: b.column}, text}], () => {
            const end = model.getPositionAt(from + text.length);
            return [new window.monaco.Selection(end.lineNumber, end.column, end.lineNumber, end.column)];
          });
          m.pushUndoStop();
          m.focus();
        }
      };
    }
    const tag = target?.tagName;
    const isTextInput = tag === 'TEXTAREA' || (tag === 'INPUT' && /^(text|search|url|tel|email)$/.test(target.type || 'text'));
    if (isTextInput && !target.readOnly && !target.disabled) {
      return {
        id: target, text: target.value, pos: target.selectionStart, empty: target.selectionStart === target.selectionEnd, bpl: true,
        rect() { return textareaRect(target); },
        insert(text, from = target.selectionStart) {
          target.focus();
          target.selectionStart = from;
          if (!document.execCommand || !document.execCommand('insertText', false, text)) {
            target.setRangeText(text, from, target.selectionEnd, 'end');
            target.dispatchEvent(new Event('input', {bubbles: true}));
          }
        }
      };
    }
    const root = editableRoot(target);
    if (root) {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return {insert: text => insertAtSelection(text)};
      const pos = offsetInEditable(root, sel.focusNode, sel.focusOffset);
      return {
        id: root, text: serializeEditable(root), pos, empty: sel.isCollapsed, bpl: true,
        rect() {
          if (!sel.rangeCount) return null;
          const r = sel.getRangeAt(0).cloneRange();
          r.collapse(false);
          return r.getClientRects()[0] || r.getBoundingClientRect();
        },
        insert(text, from) {
          root.focus?.();
          if (from != null) {
            const start = positionInEditable(root, from), end = positionInEditable(root, pos);
            const range = document.createRange();
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset);
            const s = window.getSelection();
            s.removeAllRanges();
            s.addRange(range);
          }
          insertAtSelection(text);
        }
      };
    }
    return null;
  }
  function insertAtSelection(text) {
    if (!document.execCommand || !document.execCommand('insertText', false, text)) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        range.collapse(false);
      }
    }
  }
  // ---- Left-Option-only trigger (matches lb.js's convention; right Option stays native). ----
  let leftAlt = false, rightAlt = false;
  function resetChord() {
    input?.reset();
    chordPending = false;
  }
  window.addEventListener('keydown', ev => {
    if (ev.code === 'AltLeft') leftAlt = true;
    if (ev.code === 'AltRight') rightAlt = true;
  }, true);
  window.addEventListener('keyup', ev => {
    if (ev.code === 'AltLeft') leftAlt = false;
    if (ev.code === 'AltRight') rightAlt = false;
  }, true);
  window.addEventListener('blur', () => { leftAlt = rightAlt = false; resetChord(); cancelCompletion(); });

  // ---- Completion popup UI (ported from lb.js's `tip`, minus the always-visible symbol bar). ----
  // Class name deliberately namespaced (`bpl_ext_`) to avoid colliding with a site's own native
  // `lb.js`/`input.js` integration (e.g. basedpl.rahulsaraf.online ships one), which uses
  // unprefixed `.bpl_choices`/`.ngn_lb` class names.
  const host = document.createElement('div');
  host.innerHTML = `<div class="bpl_ext_choices" role="group" aria-label="BPL symbol completions" hidden></div>
    <style>
    .bpl_ext_choices,.bpl_ext_bar{background:#eee;color:#111;font:14px -apple-system,system-ui,sans-serif;z-index:2147483647}
    .bpl_ext_choices{position:fixed;max-height:240px;max-width:min(320px,calc(100vw - 16px));overflow:auto;
      border:1px solid #888;border-radius:6px;box-shadow:0 3px 12px #0003;padding:4px}
    .bpl_ext_choices button,.bpl_ext_bar button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;padding:3px 6px;border-radius:3px}
    .bpl_ext_choices button:hover,.bpl_ext_bar button:hover{background:#777;color:#fff}
    .bpl_ext_choices button{display:block;width:100%;text-align:left;white-space:nowrap}
    .bpl_ext_choices small{display:block;padding:4px}
    .bpl_ext_choices.bpl_ext_menu{max-width:min(320px,calc(100vw - 16px))}
    .bpl_ext_menu button{display:inline-block;width:auto;min-width:28px;text-align:center}
    .bpl_ext_bar{position:fixed;top:0;left:0;right:0;border-bottom:1px solid #999;padding:2px}
    .bpl_ext_x,.bpl_ext_o{float:right}
    .bpl_ext_bar .bpl_ext_dead::after{content:'▾';font-size:9px;margin-left:1px}
    @media(prefers-color-scheme:dark){
      .bpl_ext_choices,.bpl_ext_bar{background:#222;color:#ddd}
      .bpl_ext_choices button:hover,.bpl_ext_bar button:hover{background:#bbb;color:#111}
    }
    </style>`;
  function mountHost() {
    (document.documentElement || document.head || document.body).append(host);
  }
  if (document.documentElement) mountHost();
  else document.addEventListener('DOMContentLoaded', mountHost, {once: true});
  const tip = host.querySelector('.bpl_ext_choices');
  let choice = null; // {e, item, anchor?}
  let lastEditor = null; // last-focused editor adapter, for bar-button clicks (which blur the field).

  function cancelCompletion() {
    choice?.anchor?.setAttribute('aria-expanded', 'false');
    active = null; choice = null; tip.hidden = true;
  }
  // `anchor`, when given, is a symbol-bar "dead key" button being expanded into its variant
  // glyphs (e.g. the quad-prefix button -> ⎕⌻⍠⌸...) rather than a `name completion popup.
  function showCompletion(e, item, anchor) {
    tip.classList.toggle('bpl_ext_menu', !!anchor);
    anchor?.setAttribute('aria-expanded', 'true');
    if (choice?.item.query !== item.query || choice?.anchor !== anchor) {
      tip.replaceChildren();
      for (const [glyph, name] of item.found) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = anchor ? glyph : `${glyph} ${name}`;
        b.title = name || glyph;
        b.dataset.glyph = glyph;
        tip.append(b);
      }
      if (!item.found.length) {
        const note = document.createElement('small');
        note.textContent = 'Unknown symbol';
        tip.append(note);
      }
    }
    choice = {e, item, anchor};
    tip.hidden = false;
    const r = anchor ? anchor.getBoundingClientRect() : (e.rect() || {left: 20, bottom: 20});
    tip.style.left = `${Math.max(4, Math.min(r.left, innerWidth - tip.offsetWidth - 8))}px`;
    tip.style.top = `${Math.max(4, Math.min(r.bottom + 4, innerHeight - tip.offsetHeight - 8))}px`;
  }
  tip.addEventListener('mousedown', ev => {
    ev.preventDefault();
    const b = ev.target.closest('button');
    if (b && choice) choice.e.insert(b.dataset.glyph, choice.item.start);
    cancelCompletion();
  });
  document.addEventListener('pointerdown', ev => { if (!host.contains(ev.target)) cancelCompletion(); }, true);
  for (const evName of ['paste', 'cut', 'compositionstart']) document.addEventListener(evName, cancelCompletion, true);
  document.addEventListener('focusin', ev => { lastEditor = editor(ev.target); }, true);
  document.addEventListener('pointerup', ev => { if (!host.contains(ev.target)) lastEditor = editor(ev.target); }, true);

  let active = null; // {id, start} — tracks an in-progress `name completion.
  let keyInput = false;

  function refreshCompletion(target) {
    const e = editor(target), item = e && e.bpl && input?.entry(e);
    if (item && active?.id === e.id && active.start === item.start) showCompletion(e, item);
    else cancelCompletion();
  }
  document.addEventListener('input', ev => {
    if (!autocompleteActive()) { cancelCompletion(); return; }
    if (!keyInput || (ev.inputType !== 'insertText' && ev.inputType !== 'deleteContentBackward')) cancelCompletion();
    keyInput = false;
    requestAnimationFrame(() => refreshCompletion(ev.target));
  }, true);

  // ---- Symbol bar (ported from lb.js's always-visible toolbar). Opt-in, off by default. ----
  let bar = null, barCloseBtn = null, barToggleBtn = null, barOverlay = false;
  const barOriginalPadding = document.body ? document.body.style.paddingTop : '';
  try { barOverlay = localStorage.getItem('bpl_ext_bar_overlay') === '1'; } catch {}
  function barReflow() {
    if (!bar) return;
    barToggleBtn.textContent = barOverlay ? '▼' : '▲';
    if (document.body) document.body.style.paddingTop = barOverlay || bar.hidden ? barOriginalPadding : `${bar.offsetHeight}px`;
  }
  function buildBar() {
    if (bar || !layoutData || !symbolsData) return;
    const names = new Map(symbolsData.map(({glyph, name, monad, dyad}) =>
      [glyph, [name, monad, dyad].filter(Boolean).join(' ')]));
    const shortcuts = new Map(symbolsData.map(({glyph, shortcut}) => [glyph, shortcut]));
    function stateGlyphs(state) {
      const {terminator, keys} = layoutData.states[state];
      return [terminator, ...Object.values(keys).flatMap(v => (typeof v === 'string' ? [v] : stateGlyphs(v.state)))];
    }
    const groups = new Map(Object.values(layoutData.option).filter(v => v.state).map(({state}) =>
      [layoutData.states[state].terminator, [...new Set(stateGlyphs(state))]]));
    const variants = new Set([...groups.values()].flatMap(glyphs => glyphs.slice(1)));

    bar = document.createElement('div');
    bar.className = 'bpl_ext_bar';
    bar.setAttribute('aria-label', 'BPL symbols');
    bar.hidden = true;
    barCloseBtn = document.createElement('button');
    barCloseBtn.className = 'bpl_ext_x'; barCloseBtn.type = 'button';
    barCloseBtn.title = 'Close symbol bar'; barCloseBtn.textContent = '×';
    barToggleBtn = document.createElement('button');
    barToggleBtn.className = 'bpl_ext_o'; barToggleBtn.type = 'button';
    barToggleBtn.title = 'Toggle overlay/push-down';
    bar.append(barCloseBtn, barToggleBtn);

    function makeButton(glyph, name) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = glyph; b.title = (name || glyph) + (shortcuts.get(glyph) || ''); b.dataset.glyph = glyph;
      return b;
    }
    // Related glyphs stay together; arrows meet at the boundary between dead-key groups and plain buttons.
    const order = [...new Set([
      ...'^_¯¨○⎕≡⍭↑↓←↦↢↣⇄∨∧⍺⍵∆∇⋄∊⍳⊂⊃∩∪⊥⊤⊣⊢×÷⌊⌈≤≥≠√π', ...groups.keys(), ...names.keys()
    ])];
    for (const glyph of [...order.filter(g => groups.has(g)), ...order.filter(g => !groups.has(g))]) {
      if (!groups.has(glyph) && (variants.has(glyph) || /^[\x20-\x7e]+$/.test(glyph))) continue;
      const b = makeButton(glyph, names.get(glyph));
      if (groups.has(glyph)) {
        b.textContent = {'^': '²', '_': '₂'}[glyph] || glyph;
        b.classList.add('bpl_ext_dead');
        b.setAttribute('aria-expanded', 'false');
        b.title += ' (variants)';
      }
      bar.append(b);
    }

    bar.addEventListener('mousedown', ev => {
      ev.preventDefault();
      const b = ev.target.closest('button');
      if (!b) return;
      const opened = choice?.anchor === b;
      cancelCompletion();
      if (b === barCloseBtn) { bar.hidden = true; barReflow(); }
      else if (b === barToggleBtn) {
        barOverlay = !barOverlay;
        try { localStorage.setItem('bpl_ext_bar_overlay', barOverlay ? '1' : '0'); } catch {}
        barReflow();
      } else if (b.dataset.glyph && lastEditor) {
        const glyph = b.dataset.glyph, group = groups.get(glyph);
        if (group) {
          if (!opened) showCompletion(lastEditor, {query: glyph, found: group.map(g => [g, names.get(g)])}, b);
        } else lastEditor.insert(glyph);
      }
    });
    new ResizeObserver(barReflow).observe(bar);
    host.append(bar);
    barReflow();
  }

  // ---- Per-site enable/disable state. ----
  let enabled = false;
  let autocompleteDisabled = false;
  let barEnabled = false; // opt-in, off by default.
  const siteHost = location.hostname;
  function autocompleteActive() { return enabled && !autocompleteDisabled && !!input; }
  function applyBarVisibility() {
    if (!bar) return;
    bar.hidden = !(enabled && barEnabled);
    barReflow();
  }

  function handleKeydown(ev) {
    if (!enabled || !input) return;
    if (ev.key === 'Escape' && choice) { cancelCompletion(); ev.preventDefault(); ev.stopImmediatePropagation(); return; }
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(ev.key)) return;

    const usingLeftOptionOnly = leftAlt && !rightAlt && !ev.getModifierState?.('AltGraph');
    const e = editor(ev.target);

    if (usingLeftOptionOnly || chordPending) {
      if (!e) { resetChord(); }
      else {
        const pressed = input.press(ev, usingLeftOptionOnly);
        chordPending = !!(pressed && pressed.text === '' && pressed.stop === true);
        if (pressed) {
          if (pressed.text) e.insert(pressed.text);
          if (pressed.stop) { ev.preventDefault(); ev.stopImmediatePropagation(); keyInput = false; return; }
        }
      }
    }

    if (!autocompleteActive() || !e || !e.bpl || ev.isComposing || ev.defaultPrevented) {
      if (!e) cancelCompletion();
      keyInput = false;
      return;
    }

    const item = input.entry(e);
    const plain = !ev.ctrlKey && !ev.altKey && !ev.metaKey;
    const tab = ev.key === 'Tab' && plain && !ev.shiftKey, enter = ev.key === 'Enter';
    const typed = active?.id === e.id && active.start === item?.start;
    const delimiter = plain && ev.key.length === 1 && !/[a-z]/i.test(ev.key);

    if (item && (tab || (typed && (enter || delimiter)))) {
      if (item.found.length === 1) {
        e.insert(item.found[0][0], item.start);
        cancelCompletion();
      } else if (tab) {
        active = {id: e.id, start: item.start};
        showCompletion(e, item);
      }
      if (tab) { ev.preventDefault(); ev.stopImmediatePropagation(); keyInput = false; return; }
    }

    if (ev.key === '`' && plain) {
      const updated = editor(ev.target);
      if (updated?.bpl && updated.empty && input.inCode(updated.text.slice(0, updated.pos))) {
        active = {id: updated.id, start: updated.pos};
        // Claim the backtick ahead of a site's own native BPL completion (if any), so its
        // tracking never starts and doesn't show a competing popup. The character still types
        // normally — stopping propagation doesn't prevent the default insertion.
        ev.stopImmediatePropagation();
      } else cancelCompletion();
    } else if (!(typed && plain && (/^[a-z]$/i.test(ev.key) || ev.key === 'Backspace'))) {
      cancelCompletion();
    }
    keyInput = plain && (ev.key.length === 1 || ev.key === 'Backspace');
  }
  window.addEventListener('keydown', handleKeydown, true);

  // ---- Storage-backed per-host toggles, plus live messages from the popup. ----
  function applyStoredState() {
    chrome.storage.local.get(
      {basedpl_enabled_hosts: [], basedpl_autocomplete_disabled_hosts: [], basedpl_bar_enabled_hosts: []},
      data => {
        enabled = (data.basedpl_enabled_hosts || []).includes(siteHost);
        autocompleteDisabled = (data.basedpl_autocomplete_disabled_hosts || []).includes(siteHost);
        barEnabled = (data.basedpl_bar_enabled_hosts || []).includes(siteHost);
        applyBarVisibility();
      }
    );
  }
  applyStoredState();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.basedpl_enabled_hosts) { enabled = (changes.basedpl_enabled_hosts.newValue || []).includes(siteHost); applyBarVisibility(); }
    if (changes.basedpl_autocomplete_disabled_hosts) autocompleteDisabled = (changes.basedpl_autocomplete_disabled_hosts.newValue || []).includes(siteHost);
    if (changes.basedpl_bar_enabled_hosts) { barEnabled = (changes.basedpl_bar_enabled_hosts.newValue || []).includes(siteHost); applyBarVisibility(); }
  });
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'basedpl-set-enabled' && msg.host === siteHost) {
      enabled = !!msg.enabled;
      resetChord(); cancelCompletion();
      applyBarVisibility();
      sendResponse?.({ok: true});
    }
    if (msg?.type === 'basedpl-set-autocomplete' && msg.host === siteHost) {
      autocompleteDisabled = !msg.enabled;
      cancelCompletion();
      sendResponse?.({ok: true});
    }
    if (msg?.type === 'basedpl-set-bar' && msg.host === siteHost) {
      barEnabled = !!msg.enabled;
      applyBarVisibility();
      sendResponse?.({ok: true});
    }
    if (msg?.type === 'basedpl-get-status') {
      sendResponse?.({enabled, autocompleteDisabled, barEnabled, host: siteHost, ready: !!input});
    }
  });
})();
