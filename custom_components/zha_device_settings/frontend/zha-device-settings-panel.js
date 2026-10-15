// ZHA Device Settings panel — plain web component, no build step.
// HA sets .hass on every state change, so we keep it and only re-render on our own events.

const DOMAIN = "zha_device_settings";

const DATA_TYPES = [
  [0x10, "bool"], [0x20, "uint8"], [0x21, "uint16"], [0x22, "uint24"], [0x23, "uint32"],
  [0x28, "int8"], [0x29, "int16"], [0x2b, "int32"], [0x30, "enum8"], [0x31, "enum16"],
  [0x18, "bitmap8"], [0x19, "bitmap16"],
];

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hex = (n, w = 4) => "0x" + Number(n).toString(16).toUpperCase().padStart(w, "0");
const parseNum = (v) => {
  const s = String(v).trim();
  if (s === "") return null;
  const n = s.toLowerCase().startsWith("0x") ? parseInt(s, 16) : parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
};

class ZhaDeviceSettingsPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._devices = null;
    this._selected = null; // ieee
    this._detail = null; // {definition, variant, settings}
    this._busy = new Set(); // setting ids being written
    this._loadingDetail = false;
    this._error = null;
    this._toast = null;
    this._filter = "";
    this._onlySupported = true;
    this._tab = "settings";
    this._raw = { endpoint: "1", cluster: "0xFCC0", attribute: "", manufacturer: "0x115F", data_type: "32", value: "", result: null };
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._render();
      this._loadDevices();
    }
    const menu = this.shadowRoot.querySelector("ha-menu-button");
    if (menu) menu.hass = hass;
  }

  set narrow(v) {
    this._narrow = v;
    const menu = this.shadowRoot.querySelector("ha-menu-button");
    if (menu) menu.narrow = v;
    this.toggleAttribute("narrow", !!v);
  }

  async _ws(type, data = {}) {
    return this._hass.callWS({ type: `${DOMAIN}/${type}`, ...data });
  }

  async _loadDevices() {
    try {
      this._devices = await this._ws("devices");
      this._error = null;
    } catch (e) {
      this._error = e.message || String(e);
    }
    this._render();
  }

  async _select(ieee) {
    this._selected = ieee;
    this._detail = null;
    this._loadingDetail = true;
    const dev = this._device();
    if (dev) {
      const firstEp = Object.keys(dev.endpoints)[0];
      if (firstEp) this._raw.endpoint = firstEp;
    }
    this._raw.result = null;
    this._tab = dev && dev.definition ? "settings" : "raw";
    this._render();
    try {
      this._detail = await this._ws("device_settings", { ieee });
    } catch (e) {
      this._showToast(`Couldn't read device: ${e.message || e}`, true);
    }
    this._loadingDetail = false;
    this._render();
  }

  _device() {
    return (this._devices || []).find((d) => d.ieee === this._selected);
  }

  async _write(settingId, value) {
    this._busy.add(settingId);
    this._render();
    try {
      const res = await this._ws("write_setting", { ieee: this._selected, setting_id: settingId, value });
      const s = this._detail.settings.find((x) => x.id === settingId);
      if (s) Object.assign(s, { value: res.value, status: res.status === "SUCCESS" ? "SUCCESS" : res.status });
      if (res.status === "SUCCESS") this._showToast("Saved");
      else this._showToast(`Device replied: ${res.status}`, true);
    } catch (e) {
      this._showToast(`Write failed: ${e.message || e}`, true);
    }
    this._busy.delete(settingId);
    this._render();
  }

  async _rawAction(kind) {
    const r = this._raw;
    const payload = {
      ieee: this._selected,
      endpoint: parseNum(r.endpoint),
      cluster: parseNum(r.cluster),
      attribute: parseNum(r.attribute),
      manufacturer: parseNum(r.manufacturer),
    };
    if ([payload.endpoint, payload.cluster, payload.attribute].some((v) => v === null)) {
      this._showToast("Endpoint, cluster and attribute are required", true);
      return;
    }
    try {
      if (kind === "read") {
        const res = await this._ws("raw_read", payload);
        r.result = res.status === "SUCCESS" ? `Value: ${res.value}` : `Status: ${res.status}`;
      } else {
        const value = parseNum(r.value);
        if (value === null) return this._showToast("Enter a value to write", true);
        const res = await this._ws("raw_write", { ...payload, data_type: parseInt(r.data_type, 10), value });
        r.result = `Write status: ${res.status}`;
      }
    } catch (e) {
      r.result = `Error: ${e.message || e}`;
    }
    this._render();
  }

  _showToast(msg, isError = false) {
    this._toast = { msg, isError };
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this._toast = null;
      this._render();
    }, 3000);
    this._render();
  }

  // ---------- rendering ----------

  _render() {
    if (!this._hass) return;
    const root = this.shadowRoot;
    const scroll = root.querySelector(".detail")?.scrollTop;
    root.innerHTML = `<style>${STYLES}</style>
      <div class="toolbar">
        <ha-menu-button></ha-menu-button>
        <div class="title">Zigbee Settings</div>
        <button class="icon-btn" data-action="reload" title="Reload devices">↻</button>
      </div>
      <div class="layout ${this._selected ? "has-selection" : ""}">
        <aside class="list">${this._renderList()}</aside>
        <main class="detail">${this._renderDetail()}</main>
      </div>
      ${this._toast ? `<div class="toast ${this._toast.isError ? "error" : ""}">${esc(this._toast.msg)}</div>` : ""}`;
    const menu = root.querySelector("ha-menu-button");
    if (menu) {
      menu.hass = this._hass;
      menu.narrow = this._narrow;
    }
    if (scroll) root.querySelector(".detail").scrollTop = scroll;
    this._bind();
  }

  _renderList() {
    if (this._error) return `<div class="empty error">${esc(this._error)}</div>`;
    if (!this._devices) return `<div class="empty">Loading devices…</div>`;
    const q = this._filter.toLowerCase();
    const items = this._devices.filter(
      (d) =>
        (!this._onlySupported || d.definition) &&
        (!q || [d.name, d.area, d.model, d.manufacturer].some((v) => (v || "").toLowerCase().includes(q)))
    );
    const supported = this._devices.filter((d) => d.definition).length;
    return `
      <div class="list-head">
        <input class="search" type="search" placeholder="Search devices" value="${esc(this._filter)}" data-field="filter">
        <label class="check"><input type="checkbox" data-field="onlySupported" ${this._onlySupported ? "checked" : ""}>
          Supported only <span class="muted">(${supported}/${this._devices.length})</span></label>
      </div>
      ${items.length ? "" : `<div class="empty">No devices match.</div>`}
      ${items
        .map(
          (d) => `
        <button class="device ${d.ieee === this._selected ? "active" : ""}" data-ieee="${esc(d.ieee)}">
          <span class="dev-name">${esc(d.name)}</span>
          <span class="dev-meta">${esc(d.area || "No area")} · ${esc(d.model || "unknown")}</span>
          ${d.definition ? `<span class="badge">${esc(d.variant || d.definition)}</span>` : ""}
        </button>`
        )
        .join("")}`;
  }

  _renderDetail() {
    const dev = this._device();
    if (!dev) return `<div class="empty center">Pick a device to see its settings.</div>`;
    return `
      <button class="back" data-action="back">← Devices</button>
      <header class="dev-header">
        <h1>${esc(dev.name)}</h1>
        <div class="muted">${esc(dev.manufacturer || "")} ${esc(dev.model || "")} · <code>${esc(dev.ieee)}</code></div>
      </header>
      <nav class="tabs">
        <button class="tab ${this._tab === "settings" ? "on" : ""}" data-tab="settings">Settings</button>
        <button class="tab ${this._tab === "raw" ? "on" : ""}" data-tab="raw">Raw attributes</button>
      </nav>
      ${this._tab === "settings" ? this._renderSettings(dev) : this._renderRaw(dev)}`;
  }

  _renderSettings(dev) {
    if (!dev.definition)
      return `<div class="card empty">No definition for <code>${esc(dev.model)}</code> yet. Use <b>Raw attributes</b>,
        or add a JSON definition to <code>/config/zha_device_settings/</code>.</div>`;
    if (this._loadingDetail || !this._detail)
      return `<div class="card empty">Reading settings from the device… Mains-powered devices answer in a second or two.</div>`;

    const groups = {};
    for (const s of this._detail.settings) (groups[s.group] ||= []).push(s);
    return `
      <div class="actions"><button class="text-btn" data-action="refresh">Re-read from device</button></div>
      ${Object.entries(groups)
        .map(
          ([group, items]) => `
        <section class="card">
          <h2>${esc(group)}</h2>
          ${items.map((s) => this._renderSetting(s)).join("")}
        </section>`
        )
        .join("")}`;
  }

  _renderSetting(s) {
    const busy = this._busy.has(s.id);
    const unread = s.status !== "SUCCESS";
    let control;
    if (s.control === "toggle") {
      control = `<label class="switch"><input type="checkbox" data-setting="${esc(s.id)}" data-kind="toggle"
        ${s.value ? "checked" : ""} ${busy ? "disabled" : ""}><span class="slider"></span></label>`;
    } else if (s.control === "select") {
      control = `<select data-setting="${esc(s.id)}" data-kind="select" ${busy ? "disabled" : ""}>
        ${unread || s.value === null ? `<option value="" selected disabled>Unknown</option>` : ""}
        ${(s.options || [])
          .map((o) => `<option value="${o.value}" ${o.value === s.value ? "selected" : ""}>${esc(o.label)}</option>`)
          .join("")}
      </select>`;
    } else {
      control = `<input type="number" data-setting="${esc(s.id)}" data-kind="number" value="${s.value ?? ""}"
        ${s.min != null ? `min="${s.min}"` : ""} ${s.max != null ? `max="${s.max}"` : ""} ${busy ? "disabled" : ""}>`;
    }
    return `
      <div class="setting">
        <div class="setting-text">
          <div class="setting-label">${esc(s.label)} ${busy ? `<span class="muted">saving…</span>` : ""}</div>
          <div class="setting-desc">${esc(s.description)}</div>
          ${unread ? `<div class="warn">Couldn't read current value (${esc(s.status || "no response")}). You can still set it.</div>` : ""}
          <div class="setting-addr">ep ${s.endpoint} · ${hex(s.cluster)} / ${hex(s.attribute)}${s.manufacturer != null ? ` · mfr ${hex(s.manufacturer)}` : ""}</div>
        </div>
        <div class="setting-control">${control}</div>
      </div>`;
  }

  _renderRaw(dev) {
    const r = this._raw;
    const eps = Object.entries(dev.endpoints);
    const clusters = (dev.endpoints[r.endpoint] || []).map((c) => hex(c)).join(", ");
    return `
      <section class="card">
        <h2>Read / write any attribute</h2>
        <p class="setting-desc">Look up the cluster and attribute in the device's Zigbee2MQTT converter. Manufacturer-specific
          attributes need the manufacturer code (Aqara is 0x115F).</p>
        <div class="grid">
          <label>Endpoint<select data-raw="endpoint">${eps
            .map(([id]) => `<option value="${id}" ${String(id) === String(r.endpoint) ? "selected" : ""}>${id}</option>`)
            .join("")}</select></label>
          <label>Cluster<input data-raw="cluster" value="${esc(r.cluster)}" placeholder="0xFCC0"></label>
          <label>Attribute<input data-raw="attribute" value="${esc(r.attribute)}" placeholder="0x0200"></label>
          <label>Manufacturer<input data-raw="manufacturer" value="${esc(r.manufacturer)}" placeholder="optional"></label>
          <label>Data type<select data-raw="data_type">${DATA_TYPES.map(
            ([id, name]) => `<option value="${id}" ${String(id) === String(r.data_type) ? "selected" : ""}>${name} (${hex(id, 2)})</option>`
          ).join("")}</select></label>
          <label>Value<input data-raw="value" value="${esc(r.value)}" placeholder="for write"></label>
        </div>
        <div class="muted small">Clusters on endpoint ${esc(r.endpoint)}: ${clusters || "none advertised"}</div>
        <div class="actions left">
          <button class="text-btn" data-action="raw-read">Read</button>
          <button class="primary-btn" data-action="raw-write">Write</button>
        </div>
        ${r.result ? `<div class="result"><code>${esc(r.result)}</code></div>` : ""}
      </section>`;
  }

  _bind() {
    const root = this.shadowRoot;
    root.querySelectorAll("[data-ieee]").forEach((el) =>
      el.addEventListener("click", () => this._select(el.dataset.ieee))
    );
    root.querySelectorAll("[data-tab]").forEach((el) =>
      el.addEventListener("click", () => {
        this._tab = el.dataset.tab;
        this._render();
      })
    );
    root.querySelectorAll("[data-action]").forEach((el) =>
      el.addEventListener("click", () => {
        const a = el.dataset.action;
        if (a === "reload") this._loadDevices();
        else if (a === "refresh") this._select(this._selected);
        else if (a === "back") {
          this._selected = null;
          this._render();
        } else if (a === "raw-read") this._rawAction("read");
        else if (a === "raw-write") this._rawAction("write");
      })
    );
    root.querySelectorAll("[data-setting]").forEach((el) =>
      el.addEventListener("change", () => {
        const id = el.dataset.setting;
        const kind = el.dataset.kind;
        const value = kind === "toggle" ? (el.checked ? 1 : 0) : parseInt(el.value, 10);
        if (Number.isNaN(value)) return;
        this._write(id, value);
      })
    );
    root.querySelectorAll("[data-raw]").forEach((el) =>
      el.addEventListener("change", () => {
        this._raw[el.dataset.raw] = el.value;
        if (el.dataset.raw === "endpoint") this._render();
      })
    );
    const search = root.querySelector('[data-field="filter"]');
    if (search)
      search.addEventListener("input", () => {
        this._filter = search.value;
        const pos = search.selectionStart;
        this._render();
        const s = this.shadowRoot.querySelector('[data-field="filter"]');
        s.focus();
        s.setSelectionRange(pos, pos);
      });
    const only = root.querySelector('[data-field="onlySupported"]');
    if (only)
      only.addEventListener("change", () => {
        this._onlySupported = only.checked;
        this._render();
      });
  }
}

const STYLES = `
  :host { display:block; height:100%; background:var(--primary-background-color); color:var(--primary-text-color);
    font-family:var(--paper-font-body1_-_font-family, Roboto, system-ui, sans-serif); }
  * { box-sizing:border-box; }
  .toolbar { height:56px; display:flex; align-items:center; gap:8px; padding:0 12px;
    background:var(--app-header-background-color, var(--primary-color)); color:var(--app-header-text-color, #fff);
    border-bottom:1px solid var(--divider-color); }
  .title { font-size:20px; flex:1; margin-left:4px; }
  .icon-btn { background:none; border:none; color:inherit; font-size:20px; cursor:pointer; padding:8px; border-radius:50%; }
  .layout { display:grid; grid-template-columns:320px 1fr; height:calc(100% - 56px); }
  .list { border-right:1px solid var(--divider-color); overflow-y:auto; background:var(--card-background-color); }
  .list-head { position:sticky; top:0; background:var(--card-background-color); padding:12px; border-bottom:1px solid var(--divider-color); }
  .search { width:100%; padding:8px 10px; border-radius:8px; border:1px solid var(--divider-color);
    background:var(--primary-background-color); color:inherit; font-size:14px; }
  .check { display:flex; align-items:center; gap:6px; font-size:13px; margin-top:8px; }
  .device { display:flex; flex-direction:column; align-items:flex-start; gap:2px; width:100%; text-align:left; padding:10px 14px;
    border:none; border-bottom:1px solid var(--divider-color); background:none; color:inherit; cursor:pointer; font:inherit; }
  .device:hover { background:var(--secondary-background-color); }
  .device.active { background:rgba(var(--rgb-primary-color, 3,169,244), .12); box-shadow:inset 3px 0 var(--primary-color); }
  .dev-name { font-weight:500; }
  .dev-meta, .muted { color:var(--secondary-text-color); font-size:13px; }
  .small { font-size:12px; margin-top:8px; }
  .badge { font-size:11px; padding:2px 8px; border-radius:10px; margin-top:4px;
    background:rgba(var(--rgb-primary-color, 3,169,244), .15); color:var(--primary-color); }
  .detail { overflow-y:auto; padding:16px 24px 48px; }
  .dev-header h1 { margin:4px 0; font-size:22px; font-weight:500; }
  code { font-family:var(--code-font-family, monospace); font-size:12px; }
  .tabs { display:flex; gap:4px; margin:16px 0 12px; border-bottom:1px solid var(--divider-color); }
  .tab { background:none; border:none; color:var(--secondary-text-color); padding:10px 14px; cursor:pointer; font:inherit;
    border-bottom:2px solid transparent; }
  .tab.on { color:var(--primary-color); border-bottom-color:var(--primary-color); }
  .card { background:var(--card-background-color); border-radius:var(--ha-card-border-radius, 12px);
    border:1px solid var(--divider-color); padding:4px 16px 12px; margin-bottom:16px; max-width:760px; }
  .card h2 { font-size:15px; font-weight:500; margin:14px 0 4px; }
  .card.empty { padding:24px; }
  .setting { display:flex; gap:16px; align-items:center; padding:12px 0; border-top:1px solid var(--divider-color); }
  .card h2 + .setting { border-top:none; }
  .setting-text { flex:1; min-width:0; }
  .setting-label { font-weight:500; }
  .setting-desc { color:var(--secondary-text-color); font-size:13px; margin-top:2px; }
  .setting-addr { color:var(--disabled-text-color, #999); font-size:11px; margin-top:4px; font-family:var(--code-font-family, monospace); }
  .warn { color:var(--warning-color, #ff9800); font-size:12px; margin-top:4px; }
  select, input[type=number], .grid input { padding:8px 10px; border-radius:8px; border:1px solid var(--divider-color);
    background:var(--primary-background-color); color:inherit; font:inherit; min-width:160px; }
  .switch { position:relative; width:40px; height:22px; display:inline-block; }
  .switch input { opacity:0; width:0; height:0; }
  .slider { position:absolute; inset:0; background:var(--switch-unchecked-track-color, #9e9e9e); border-radius:22px; transition:.2s; cursor:pointer; }
  .slider:before { content:""; position:absolute; width:18px; height:18px; left:2px; top:2px; background:#fff; border-radius:50%; transition:.2s; }
  .switch input:checked + .slider { background:var(--primary-color); }
  .switch input:checked + .slider:before { transform:translateX(18px); }
  .switch input:disabled + .slider { opacity:.5; }
  .actions { display:flex; justify-content:flex-end; gap:8px; max-width:760px; margin-bottom:8px; }
  .actions.left { justify-content:flex-start; margin-top:12px; }
  .text-btn, .primary-btn, .back { font:inherit; font-size:14px; padding:8px 14px; border-radius:8px; cursor:pointer; }
  .text-btn { background:none; border:1px solid var(--divider-color); color:var(--primary-color); }
  .primary-btn { background:var(--primary-color); border:none; color:var(--text-primary-color, #fff); }
  .back { display:none; background:none; border:none; color:var(--primary-color); padding:4px 0; margin-bottom:8px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(170px, 1fr)); gap:12px; margin-top:12px; }
  .grid label { display:flex; flex-direction:column; gap:4px; font-size:13px; color:var(--secondary-text-color); }
  .grid select, .grid input { min-width:0; width:100%; }
  .result { margin-top:12px; padding:10px; border-radius:8px; background:var(--secondary-background-color); }
  .empty { padding:24px; color:var(--secondary-text-color); }
  .empty.center { text-align:center; margin-top:15vh; }
  .error { color:var(--error-color, #db4437); }
  .toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); padding:10px 18px; border-radius:8px;
    background:#323232; color:#fff; font-size:14px; box-shadow:0 4px 12px rgba(0,0,0,.3); z-index:10; }
  .toast.error { background:var(--error-color, #db4437); }
  :host(:not([narrow])) ha-menu-button { display:none; }
  @media (max-width: 800px) {
    .layout { grid-template-columns:1fr; }
    .layout.has-selection .list { display:none; }
    .layout:not(.has-selection) .detail { display:none; }
    .back { display:inline-block; }
    .detail { padding:12px 16px 48px; }
    .setting { flex-direction:column; align-items:stretch; gap:8px; }
    select, input[type=number] { width:100%; }
  }
`;

customElements.define("zha-device-settings-panel", ZhaDeviceSettingsPanel);
