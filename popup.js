(() => {
  const hostEl = document.getElementById('host');
  const toggle = document.getElementById('toggle');
  const autocompleteToggle = document.getElementById('autocompleteToggle');
  const autocompleteRow = document.getElementById('autocompleteRow');
  const barToggle = document.getElementById('barToggle');
  const barRow = document.getElementById('barRow');
  let host = null, tabId = null;

  function sendToTab(message) {
    if (tabId == null) return;
    chrome.tabs.sendMessage(tabId, message, () => { void chrome.runtime.lastError; });
  }
  function refreshSubRowState() {
    const rows = [autocompleteRow, barRow];
    for (const row of rows) {
      if (toggle.checked) row.removeAttribute('data-disabled');
      else row.setAttribute('data-disabled', '');
    }
  }

  chrome.tabs.query({active: true, currentWindow: true}, ([tab]) => {
    if (!tab?.url) { hostEl.textContent = '(no active tab)'; toggle.disabled = true; autocompleteToggle.disabled = true; barToggle.disabled = true; return; }
    tabId = tab.id;
    try { host = new URL(tab.url).hostname; } catch { host = null; }
    if (!host) { hostEl.textContent = '(unsupported page)'; toggle.disabled = true; autocompleteToggle.disabled = true; barToggle.disabled = true; return; }
    hostEl.textContent = host;
    chrome.storage.local.get(
      {basedpl_enabled_hosts: [], basedpl_autocomplete_disabled_hosts: [], basedpl_bar_enabled_hosts: []},
      data => {
        toggle.checked = (data.basedpl_enabled_hosts || []).includes(host);
        autocompleteToggle.checked = !(data.basedpl_autocomplete_disabled_hosts || []).includes(host);
        barToggle.checked = (data.basedpl_bar_enabled_hosts || []).includes(host);
        refreshSubRowState();
      }
    );
  });

  toggle.addEventListener('change', () => {
    if (!host) return;
    refreshSubRowState();
    chrome.storage.local.get({basedpl_enabled_hosts: []}, data => {
      const hosts = new Set(data.basedpl_enabled_hosts || []);
      if (toggle.checked) hosts.add(host); else hosts.delete(host);
      chrome.storage.local.set({basedpl_enabled_hosts: [...hosts]}, () => {
        sendToTab({type: 'basedpl-set-enabled', host, enabled: toggle.checked});
      });
    });
  });

  autocompleteToggle.addEventListener('change', () => {
    if (!host) return;
    chrome.storage.local.get({basedpl_autocomplete_disabled_hosts: []}, data => {
      const hosts = new Set(data.basedpl_autocomplete_disabled_hosts || []);
      if (autocompleteToggle.checked) hosts.delete(host); else hosts.add(host);
      chrome.storage.local.set({basedpl_autocomplete_disabled_hosts: [...hosts]}, () => {
        sendToTab({type: 'basedpl-set-autocomplete', host, enabled: autocompleteToggle.checked});
      });
    });
  });

  barToggle.addEventListener('change', () => {
    if (!host) return;
    chrome.storage.local.get({basedpl_bar_enabled_hosts: []}, data => {
      const hosts = new Set(data.basedpl_bar_enabled_hosts || []);
      if (barToggle.checked) hosts.add(host); else hosts.delete(host);
      chrome.storage.local.set({basedpl_bar_enabled_hosts: [...hosts]}, () => {
        sendToTab({type: 'basedpl-set-bar', host, enabled: barToggle.checked});
      });
    });
  });
})();
