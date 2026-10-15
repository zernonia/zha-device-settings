#!/usr/bin/env node
// Generate ZHA Device Settings definitions from zigbee-herdsman-converters.
//
// Rather than re-implementing Z2M's converters, we *run* them: every settable
// expose is fed each of its possible values through its toZigbee converter
// against a mock device that records the ZCL writes. The recording is the
// ground truth for which endpoint/cluster/attribute/type/value ZHA must send.
//
// Usage: node generate.js [vendorFile ...]   (default: VENDORS below)
// Output: ../custom_components/zha_device_settings/definitions/<vendor>.json

"use strict";
const fs = require("fs");
const path = require("path");

const ZHC_DIST = path.join(path.dirname(require.resolve("zigbee-herdsman-converters")));
const zhc = require("zigbee-herdsman-converters");
const quiet = {debug() {}, info() {}, warning() {}, error() {}};
zhc.setLogger(quiet);
const {Zcl} = require("zigbee-herdsman");
const ZHC_VERSION = require(path.join(ZHC_DIST, "..", "package.json")).version;

const OUT_DIR = path.join(__dirname, "..", "custom_components", "zha_device_settings", "definitions");

// Attributes ZHA already exposes as entities (from export_zha_builtins.py). They're kept,
// so everything is configurable in one place, but tagged so the panel can show it.
const ZHA_BUILTINS = require("./zha_builtin_attributes.json");
const BUILTIN_GENERIC = new Set(ZHA_BUILTINS.generic.map(([c, a]) => `${c}:${a}`));
function zhaAlreadyExposes(models, target) {
    if (!target) return false;
    const k = `${target.cluster}:${target.attribute}`;
    if (BUILTIN_GENERIC.has(k)) return true;
    return models.some((m) => (ZHA_BUILTINS.by_model[m] || []).some(([c, a]) => `${c}:${a}` === k));
}
const SET = 0b010;

// Vendor files (zigbee-herdsman-converters/dist/devices/<name>.js) bundled with the integration.
const VENDORS = ["lumi", "philips", "ikea", "innr", "sonoff"];

// Settable exposes that are everyday controls ZHA already provides as entities.
const RUNTIME_PROPS = new Set([
    "state", "brightness", "color", "color_temp", "color_xy", "color_hs", "position", "tilt",
    "effect", "occupied_heating_setpoint", "current_heating_setpoint", "system_mode", "running_state",
    "fan_mode", "alarm", "volume", "melody", "duration", "identify", "do_not_disturb_start",
]);

// Some converters refuse to run without prior state or options. These hints supply
// what a real Z2M instance would already have; the recorded write doesn't depend on them.
const STATE_HINTS = {
    temperature_sensor_select: {state: {external_temperature_input: 20}},
    external_temperature_input: {state: {sensor: "external"}},
    ntc_sensor_type: {options: {}, state: {ntc_r25: 10000, ntc_beta: 3950}},
};

// ---------- mock device ----------

const MOCK_IEEES = ["0x00158d0001000000", "0x54ef44100a0b0c0d"];
// Each capture runs with its own frozen clock and random source, so timestamps or
// randomness in a payload show up as differences between the two captures.
const MOCK_CLOCKS = {[MOCK_IEEES[0]]: [1700000000123, 0.25], [MOCK_IEEES[1]]: [1800000000456, 0.75]};
const realNow = Date.now, realRandom = Math.random;

function makeDevice(zigbeeModel, ieeeAddr = MOCK_IEEES[0]) {
    const writes = [];
    const endpoints = new Map();
    const device = {
        ieeeAddr,
        networkAddress: 0x1234,
        modelID: zigbeeModel,
        manufacturerName: "LUMI",
        manufacturerID: 0x115f,
        powerSource: "Mains (single phase)",
        type: "Router",
        softwareBuildID: "0.0.0_0001",
        interviewCompleted: true,
        isDeleted: false,
        meta: {},
        customClusters: {},
        save() {},
        addCustomCluster(name, def) { this.customClusters[name] = def; },
        getEndpoint(id) {
            if (!endpoints.has(id)) endpoints.set(id, makeEndpoint(id, device, writes));
            return endpoints.get(id);
        },
        get endpoints() { return [...endpoints.values()]; },
    };
    for (const id of [1, 2, 3, 4, 5, 6, 21, 41, 242]) device.getEndpoint(id);
    return {device, writes};
}

// Z2M's utils.isEndpoint() checks constructor.name, so the mock must be a class named Endpoint.
class Endpoint {}

function makeEndpoint(ID, device, writes) {
    return Object.assign(new Endpoint(), {
        ID,
        deviceIeeeAddress: device.ieeeAddr,
        inputClusters: [],
        outputClusters: [],
        clusters: {},
        getDevice: () => device,
        supportsInputCluster: () => true,
        supportsOutputCluster: () => true,
        async write(cluster, payload, options) {
            writes.push({endpoint: ID, cluster, payload, options: options ?? {}});
        },
        async read() { return {}; },
        async command(cluster, command, payload, options) {
            writes.push({endpoint: ID, cluster, command, payload, options: options ?? {}});
        },
        async bind() {}, async unbind() {}, async configureReporting() {},
        saveClusterAttributeKeyValue() {}, getClusterAttributeValue() { return undefined; },
    });
}

// ---------- ZCL resolution ----------

function resolveCluster(name, device, mfr) {
    if (typeof name === "number") return {ID: name, attributes: {}};
    return Zcl.Utils.getCluster(name, mfr, device.customClusters);
}

function attrByKey(cluster, key) {
    if (/^\d+$/.test(String(key))) {
        const id = Number(key);
        return Object.values(cluster.attributes || {}).find((a) => a.ID === id) || {ID: id};
    }
    return (cluster.attributes || {})[key] || Object.values(cluster.attributes || {}).find((a) => a.name === key);
}

// ---------- encoding of composite ZCL types ----------
// Arrays (0x48) and structs (0x4C) are serialized here into the bytes that follow the
// type id on the wire, and sent as-is by the integration ("raw": true).

const SCALAR_SIZES = {0x10: [1, false], 0x18: [1, false], 0x19: [2, false], 0x1a: [3, false], 0x1b: [4, false],
    0x20: [1, false], 0x21: [2, false], 0x22: [3, false], 0x23: [4, false],
    0x28: [1, true], 0x29: [2, true], 0x2a: [3, true], 0x2b: [4, true], 0x30: [1, false], 0x31: [2, false]};

function encodeScalar(type, v) {
    const spec = SCALAR_SIZES[type];
    if (!spec || !Number.isInteger(Number(v))) return null;
    const [size, signed] = spec;
    let n = BigInt(Number(v));
    if (n < 0n) {
        if (!signed) return null;
        n += 1n << BigInt(size * 8);
    }
    const out = [];
    for (let i = 0; i < size; i++) out.push(Number((n >> BigInt(8 * i)) & 0xffn));
    return out;
}

function toArray(elements) {
    if (Array.isArray(elements)) return elements;
    if (elements && elements.type === "Buffer" && Array.isArray(elements.data)) return elements.data;
    if (Buffer.isBuffer(elements)) return [...elements];
    if (elements && typeof elements === "object") {
        return Object.keys(elements).sort((a, b) => a - b).map((k) => elements[k]);
    }
    return null;
}

function encodeComposite(type, value) {
    if (type === 0x48 && value && "elementType" in value) {
        const items = toArray(value.elements);
        if (!items) return null;
        const bytes = [value.elementType, ...encodeScalar(0x21, items.length)];
        for (const it of items) {
            const e = encodeScalar(value.elementType, Buffer.isBuffer(it) ? it[0] : it);
            if (!e) return null;
            bytes.push(...e);
        }
        return bytes;
    }
    if (type === 0x4c && Array.isArray(value)) {
        const bytes = [...encodeScalar(0x21, value.length)];
        for (const el of value) {
            const e = encodeScalar(el.elmType, el.elmVal);
            if (!e) return null;
            bytes.push(el.elmType, ...e);
        }
        return bytes;
    }
    return null;
}

// Turn recorded writes into flat [{endpoint, cluster, attribute, type, manufacturer, value}]
function flattenWrites(raw, device) {
    const out = [];
    const why = (m, w) => { if (process.env.DEBUG_SKIP) console.error(`reject: ${m}`, JSON.stringify(w)); return null; };
    for (const w of raw) {
        if (w.command) return why("command", w); // command-based setting: not supported (yet)
        const mfr = w.options.manufacturerCode;
        let cluster;
        try {
            cluster = resolveCluster(w.cluster, device, mfr);
        } catch (e) {
            return why(`cluster ${e.message}`, w);
        }
        for (const [key, v] of Object.entries(w.payload)) {
            const attr = attrByKey(cluster, key);
            let type = attr && attr.type;
            let value = v;
            if (v && typeof v === "object" && !Array.isArray(v) && !Buffer.isBuffer(v) && "value" in v) {
                type = v.type;
                value = v.value;
            }
            if (!attr || attr.ID === undefined || type === undefined) return why(`attr ${key}`, w);
            const manufacturer = mfr ?? (cluster.manufacturerCode !== undefined && attr.manufacturerCode === undefined ? cluster.manufacturerCode : attr.manufacturerCode) ?? null;
            if (type === 0x48 || type === 0x4c) {
                const bytes = encodeComposite(type, value);
                if (!bytes) return why(`composite ${type}`, w);
                out.push({endpoint: w.endpoint, cluster: cluster.ID, attribute: attr.ID, type, manufacturer, value: bytes, raw: true});
                continue;
            }
            if (Buffer.isBuffer(value)) value = [...value];
            const bytesType = type === 0x41 || type === 0x43;
            // Z2M sometimes passes [n] for scalar types and relies on JS coercion.
            if (!bytesType && Array.isArray(value) && value.length === 1) value = value[0];
            if (typeof value === "boolean") value = value ? 1 : 0;
            const isFloat = type === 0x38 || type === 0x39 || type === 0x3a;
            const isBytes = bytesType && Array.isArray(value) && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);
            const ok = isBytes || (isFloat ? typeof value === "number" : Number.isInteger(value));
            if (!ok) return why(`value ${JSON.stringify(value)} type ${type}`, w);
            out.push({
                endpoint: w.endpoint,
                cluster: cluster.ID,
                attribute: attr.ID,
                type,
                manufacturer,
                value,
            });
        }
    }
    return out.length ? out : null;
}

// ---------- expose walking ----------

function flatFeatures(exposes) {
    const out = [];
    const walk = (e) => {
        if (e.features && e.type !== "enum") {
            // composites write the whole object at once; only descend into generic containers
            if (e.type === "composite" || e.type === "list") return;
            e.features.forEach(walk);
            return;
        }
        out.push(e);
    };
    exposes.forEach(walk);
    return out;
}

function findConverter(def, feature) {
    const name = feature.property;
    const base = feature.endpoint ? name.replace(new RegExp(`_${feature.endpoint}$`), "") : name;
    for (const c of def.toZigbee) {
        if (!c.convertSet || !c.key) continue;
        if (["read", "write", "command", "zcl_command"].some((k) => c.key.length === 1 && c.key[0] === k)) continue;
        if (c.endpoints && feature.endpoint && !c.endpoints.includes(feature.endpoint)) continue;
        if (c.key.includes(base) || c.key.includes(name)) return {converter: c, key: c.key.includes(base) ? base : name};
    }
    return null;
}

const humanize = (s) => fixCase(String(s).replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()));

// ---------- label polish ----------

const ACRONYMS = {led: "LED", lcd: "LCD", pir: "PIR", ai: "AI", ntc: "NTC", off: "off", on: "on"};
function fixCase(label) {
    return label.replace(/\b([A-Za-z]+)\b/g, (w, _, i) => {
        const a = ACRONYMS[w.toLowerCase()];
        if (!a) return w;
        if (a === "off" || a === "on") return i === 0 ? w : a; // "Auto OFF" -> "Auto off", but keep "On" option labels
        return a;
    });
}

// Clearer names for common Z2M properties. `invert` flips a negative toggle
// ("LED disabled at night" ON = dark) into a positive one ("LED at night" ON = lit).
const OVERRIDES = {
    led_disabled_night: {label: "LED indicator at night", invert: true,
        description: "Turn off to keep the indicator LED dark during night hours."},
    disable_led_at_night: {label: "LED indicator at night", invert: true,
        description: "Turn off to keep the indicator LED dark during night hours."},
    operation_mode: {label: "Button mode",
        description: "Decoupled: the button only sends an event and doesn't switch its relay. Use with smart bulbs so they stay powered."},
    power_outage_memory: {label: "Restore state after power loss",
        description: "When power returns, switch back to the state before the outage."},
    flip_indicator_light: {label: "Invert indicator LED",
        description: "Light the LED while the switch is off instead of on, so it's easy to find in the dark."},
    power_on_behavior: {label: "Power-on behaviour",
        description: "What the relay does when power returns after an outage."},
    mode_switch: {label: "Switch mode",
        description: "Anti-flicker fixes blinking on some low-wattage LED bulbs. Quick mode responds faster."},
    lock_relay: {label: "Lock relay",
        description: "Keep the relay in its current state. Neither the button nor Zigbee commands can change it."},
    click_mode: {label: "Click mode",
        description: "Fast reacts instantly but only reports single presses. Multi waits briefly to detect double press and hold."},
    multi_click: {label: "Multi-click", description: "Allow double press and hold events, at the cost of a slightly slower response."},
    auto_off: {label: "Auto off"},
    led_indicator: {label: "LED indicator"},
    button_lock: {label: "Button lock", description: "Disable the physical button."},
    child_lock: {label: "Child lock"},
};

function polish(feature, setting) {
    setting.description = setting.description.replace(/Zigbee2MQTT|Z2M/g, "Home Assistant").replace(/\.(?=[A-Z])/g, ". ");
    const o = OVERRIDES[feature.name];
    if (!o) {
        setting.label = fixCase(setting.label);
        return setting;
    }
    const suffix = feature.endpoint ? ` (${humanize(feature.endpoint)})` : "";
    setting.label = o.label + suffix;
    if (o.description) setting.description = o.description;
    if (o.invert && setting.control === "toggle" && setting.options.length === 2) {
        const [off, on] = setting.options;
        setting.options = [{...on, label: "Off"}, {...off, label: "On"}];
    }
    return setting;
}

async function capture(def, zigbeeModel, feature, conv, value, ieee = MOCK_IEEES[0]) {
    const [now, rnd] = MOCK_CLOCKS[ieee];
    Date.now = () => now;
    Math.random = () => rnd;
    try {
        return await captureInner(def, zigbeeModel, feature, conv, value, ieee);
    } finally {
        Date.now = realNow;
        Math.random = realRandom;
    }
}

async function captureInner(def, zigbeeModel, feature, conv, value, ieee) {
    const {device, writes} = makeDevice(zigbeeModel, ieee);
    try {
        const lumiLib = require(path.join(ZHC_DIST, "lib", "lumi.js"));
        lumiLib.lumiModernExtend?.addManuSpecificLumiCluster?.().configure[0](device);
    } catch (e) { /* not a lumi device */ }
    if (typeof def.onEvent === "function") {
        try { await def.onEvent({type: "start", data: {device}, definition: def}); } catch (e) {}
    }
    let epId = 1;
    if (feature.endpoint && def.endpoint) {
        try { epId = def.endpoint(device)[feature.endpoint] ?? 1; } catch (e) {}
    }
    const entity = device.getEndpoint(epId);
    const meta = {
        device, mapped: def, options: {...(STATE_HINTS[feature.name]?.options ?? {})},
        state: {...(STATE_HINTS[feature.name]?.state ?? {})}, logger: quiet,
        message: {[conv.key]: value}, endpoint_name: feature.endpoint, converterOptions: {}, publish: () => {}, membersState: {},
    };
    try {
        await Promise.race([
            conv.converter.convertSet(entity, conv.key, value, meta),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500)),
        ]);
    } catch (e) {
        // A timeout after writes were recorded (e.g. converters that sleep then poll) is still usable.
        if (!(e.message === "timeout" && writes.length)) return {error: e.message};
    }
    return {writes: flattenWrites(writes, device), epId, device};
}

const sameTarget = (a, b) =>
    a.endpoint === b.endpoint && a.cluster === b.cluster && a.attribute === b.attribute && a.type === b.type && a.manufacturer === b.manufacturer;

const ieeeBytes = (hex, endian) => {
    const be = hex.replace(/^0x/, "").match(/../g).map((h) => parseInt(h, 16));
    return endian === "be" ? be : be.reverse();
};

const tsBytes = (ms, endian) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(Math.floor(ms / 1000) >>> 0);
    return endian === "be" ? [...b] : [...b].reverse();
};
const DYNAMIC_KINDS = [
    {kind: "ieee", size: 8, bytes: (ieee, endian) => ieeeBytes(ieee, endian)},
    {kind: "timestamp", size: 4, bytes: (ieee, endian) => tsBytes(MOCK_CLOCKS[ieee][0], endian)},
];

// Compare writes captured with the two mock devices/clocks. Returns
// {writeIndex: [{kind, byte, endian}]} if every difference is the device's IEEE address
// or the current Unix time (both filled in by the integration at write time), else null.
function findDynamicSlots(wa, wb) {
    if (wa.length !== wb.length) return null;
    const slots = {};
    for (let i = 0; i < wa.length; i++) {
        const a = wa[i], b = wb[i];
        if (JSON.stringify(a) === JSON.stringify(b)) continue;
        if (!Array.isArray(a.value) || !Array.isArray(b.value) || a.value.length !== b.value.length) return null;
        const patched = [...a.value];
        const found = [];
        for (const {kind, size, bytes} of DYNAMIC_KINDS) {
            for (const endian of ["be", "le"]) {
                const ia = bytes(MOCK_IEEES[0], endian), ib = bytes(MOCK_IEEES[1], endian);
                for (let p = 0; p + size <= a.value.length; p++) {
                    if (found.some((f) => p < f.byte + f.size && f.byte < p + size)) continue;
                    if (ia.every((x, k) => a.value[p + k] === x) && ib.every((x, k) => b.value[p + k] === x)) {
                        found.push({kind, byte: p, endian, size});
                        ib.forEach((x, k) => (patched[p + k] = x));
                    }
                }
            }
        }
        if (!found.length || JSON.stringify(patched) !== JSON.stringify(b.value)) return null;
        slots[i] = found.map(({size, ...f}) => f);
    }
    return Object.keys(slots).length ? slots : null;
}

// Given captures [{value, writes}] that differ only in one place, find a linear encoding
// raw = value * scale + offset stored either as a scalar write value or as bytes in a payload.
function findPatch(caps) {
    const n = caps[0].writes.length;
    if (!caps.every((c) => c.writes.length === n)) return null;
    let idx = -1;
    for (let i = 0; i < n; i++) {
        const strip = (w) => JSON.stringify({...w, value: undefined});
        if (!caps.every((c) => strip(c.writes[i]) === strip(caps[0].writes[i]))) return null;
        if (!caps.every((c) => JSON.stringify(c.writes[i].value) === JSON.stringify(caps[0].writes[i].value))) {
            if (idx !== -1) return null; // more than one varying write
            idx = i;
        }
    }
    if (idx === -1) return null;
    const fit = (pairs) => {
        const [a, b] = pairs;
        if (b[0] === a[0]) return null;
        const scale = (b[1] - a[1]) / (b[0] - a[0]);
        const offset = a[1] - scale * a[0];
        return pairs.every(([v, r]) => Math.abs(v * scale + offset - r) < 0.5) ? {scale: +scale.toFixed(6), offset: +offset.toFixed(6)} : null;
    };
    const vals = caps.map((c) => c.writes[idx].value);
    if (vals.every((v) => typeof v === "number")) {
        const f = fit(caps.map((c, i) => [c.value, vals[i]]));
        return f && {...f, patch: {write: idx, scalar: true}};
    }
    if (!vals.every((v) => Array.isArray(v) && v.length === vals[0].length)) return null;
    const diff = [];
    for (let b = 0; b < vals[0].length; b++) if (!vals.every((v) => v[b] === vals[0][b])) diff.push(b);
    if (!diff.length) return null;
    const [dlo, dhi] = [diff[0], diff[diff.length - 1]];
    for (const width of [1, 2, 3, 4]) {
        for (let start = Math.max(0, dhi - width + 1); start <= dlo && start + width <= vals[0].length; start++) {
            for (const endian of ["le", "be"]) {
                for (const signed of [false, true]) {
                    const decode = (v) => {
                        let bytes = v.slice(start, start + width);
                        if (endian === "be") bytes = bytes.reverse();
                        let n = bytes.reduce((acc, byte, i) => acc + byte * 2 ** (8 * i), 0);
                        if (signed && n >= 2 ** (8 * width - 1)) n -= 2 ** (8 * width);
                        return n;
                    };
                    const f = fit(caps.map((c, i) => [c.value, decode(vals[i])]));
                    if (f) return {...f, patch: {write: idx, byte: start, width, endian, signed}};
                }
            }
        }
    }
    return null;
}

// Clamp a UI range so value * scale + offset always fits the wire type / byte field.
function clampRange(setting, rawLo, rawHi) {
    const {scale, offset} = setting;
    if (!scale) return setting;
    const toUi = (r) => (r - offset) / scale;
    let [uiA, uiB] = [toUi(rawLo), toUi(rawHi)].sort((a, b) => a - b);
    uiA = Math.ceil(uiA * 1e6) / 1e6;
    uiB = Math.floor(uiB * 1e6) / 1e6;
    if (setting.min === null || setting.min < uiA) setting.min = uiA;
    if (setting.max === null || setting.max > uiB) setting.max = uiB;
    return setting;
}

const RAW_RANGE = {0x10: [0, 1], 0x18: [0, 255], 0x19: [0, 65535], 0x20: [0, 255], 0x21: [0, 65535], 0x22: [0, 2 ** 24 - 1],
    0x23: [0, 2 ** 32 - 1], 0x28: [-128, 127], 0x29: [-32768, 32767], 0x2a: [-(2 ** 23), 2 ** 23 - 1],
    0x2b: [-(2 ** 31), 2 ** 31 - 1], 0x30: [0, 255], 0x31: [0, 65535]};

async function buildSetting(def, zigbeeModel, feature) {
    const conv = findConverter(def, feature);
    if (!conv) return {skip: "no converter"};

    const label = (feature.label || humanize(feature.name)) + (feature.endpoint ? ` (${humanize(feature.endpoint)})` : "");
    const base = {
        key: feature.property,
        label,
        description: feature.description || "",
        group: feature.category === "config" ? "Configuration" : "Controls",
    };

    let values;
    if (feature.type === "binary") values = [feature.value_off, feature.value_on];
    else if (feature.type === "enum") values = feature.values;
    else if (feature.type === "numeric") {
        const min = feature.value_min ?? 0;
        const max = feature.value_max ?? Math.max(min + 100, 100);
        values = [min, max, Math.round((min + max) / 2)];
    } else return {skip: `type ${feature.type}`};

    const results = [];
    for (const v of values) {
        // Capture twice with different device addresses. Payloads that embed the
        // device's IEEE address, sequence counters or timestamps differ between
        // runs and can't be replayed as fixed bytes, so they're skipped.
        const r = await capture(def, zigbeeModel, feature, conv, v, MOCK_IEEES[0]);
        if (r.error) return {skip: `converter error: ${r.error}`};
        if (!r.writes) return {skip: "unsupported write shape"};
        const r2 = await capture(def, zigbeeModel, feature, conv, v, MOCK_IEEES[1]);
        if (r2.error) return {skip: "device-specific payload"};
        if (JSON.stringify(r2.writes) !== JSON.stringify(r.writes)) {
            // Allowed only if the differences are the device's own IEEE address or the
            // current time, which the integration substitutes at write time.
            const dyn = findDynamicSlots(r.writes, r2.writes);
            if (!dyn) return {skip: "device-specific payload"};
            r.writes = r.writes.map((w, i) => (dyn[i] ? {...w, dynamic: dyn[i]} : w));
        }
        results.push({value: v, writes: r.writes});
    }

    const single = results.every((r) => r.writes.length === 1 && typeof r.writes[0].value === "number") &&
        results.every((r) => sameTarget(r.writes[0], results[0].writes[0]));
    const target = single ? (({value, ...t}) => t)(results[0].writes[0]) : null;

    if (feature.type === "numeric") {
        if (!single) {
            // The number may be embedded in a byte payload (or one of several writes):
            // find where it lives and how it's encoded, then store a patchable template.
            const extra = [];
            const lo = feature.value_min ?? 0, hi = feature.value_max ?? Math.max(lo + 100, 100);
            for (const v of [Math.round(lo + (hi - lo) / 4), lo + (feature.value_step ?? 1)]) {
                const r = await capture(def, zigbeeModel, feature, conv, v, MOCK_IEEES[0]);
                if (r.error || !r.writes) return {skip: "numeric without a single attribute"};
                extra.push({value: v, writes: r.writes});
            }
            const patch = findPatch([...results, ...extra]);
            if (!patch) return {skip: "numeric without a single attribute"};
            const setting = {...base, control: "number", target: null, min: feature.value_min ?? null, max: feature.value_max ?? null,
                step: feature.value_step ?? 1, unit: feature.unit || null, scale: patch.scale, offset: patch.offset,
                template: {writes: results[0].writes, patch: patch.patch}};
            const p = patch.patch;
            const range = p.scalar ? RAW_RANGE[results[0].writes[p.write].type]
                : p.signed ? [-(2 ** (8 * p.width - 1)), 2 ** (8 * p.width - 1) - 1] : [0, 2 ** (8 * p.width) - 1];
            if (range) clampRange(setting, ...range);
            return {setting};
        }
        const [a, b, c] = results;
        const ra = a.writes[0].value, rb = b.writes[0].value, rc = c.writes[0].value;
        const scale = b.value === a.value ? 1 : (rb - ra) / (b.value - a.value);
        const offset = ra - scale * a.value;
        if (Math.abs(scale * c.value + offset - rc) > 1) return {skip: "non-linear numeric"};
        const setting = {...base, control: "number", target, min: feature.value_min ?? null, max: feature.value_max ?? null,
            step: feature.value_step ?? 1, unit: feature.unit || null, scale: +scale.toFixed(6), offset: +offset.toFixed(6)};
        if (RAW_RANGE[target.type]) clampRange(setting, ...RAW_RANGE[target.type]);
        return {setting};
    }

    const control = feature.type === "binary" ? "toggle" : "select";
    const options = results.map((r) => ({
        label: feature.type === "binary" ? (r.value === feature.value_on ? "On" : "Off") : humanize(r.value),
        ...(single ? {raw: r.writes[0].value} : {writes: r.writes}),
    }));
    if (single && new Set(options.map((o) => o.raw)).size !== options.length) return {skip: "ambiguous raw values"};
    return {setting: {...base, control, target, options}};
}

async function processVendor(file) {
    const mod = require(path.join(ZHC_DIST, "devices", `${file}.js`));
    const devices = [];
    const skipped = {};
    for (const raw of mod.definitions) {
        if (!raw.zigbeeModel || !raw.zigbeeModel.length) continue;
        let def;
        try { def = zhc.prepareDefinition(raw); } catch (e) { skipped[raw.model] = `prepare: ${e.message}`; continue; }
        const zigbeeModel = raw.zigbeeModel[0];
        let exposes;
        try {
            exposes = typeof def.exposes === "function" ? def.exposes(makeDevice(zigbeeModel).device, {}) : def.exposes;
        } catch (e) { skipped[raw.model] = `exposes: ${e.message}`; continue; }

        const settings = [];
        for (const f of flatFeatures(exposes)) {
            if (!f.property || !(f.access & SET)) continue;
            if (RUNTIME_PROPS.has(f.name) && f.category !== "config") continue;
            const r = await buildSetting(def, zigbeeModel, f);
            if (r.setting) {
                if (zhaAlreadyExposes(raw.zigbeeModel, r.setting.target)) r.setting.zha_entity = true;
                settings.push(polish(f, r.setting));
            }
            else (skipped[raw.model] ||= []).push(`${f.property}: ${r.skip}`);
        }
        if (!settings.length) continue;
        devices.push({
            models: raw.zigbeeModel,
            model: raw.model,
            name: `${raw.vendor} ${raw.description}`,
            settings,
        });
    }
    return {devices, skipped};
}

(async () => {
    const vendors = process.argv.slice(2).length ? process.argv.slice(2) : VENDORS;
    for (const vendor of vendors) {
        const {devices, skipped} = await processVendor(vendor);
        devices.sort((a, b) => a.name.localeCompare(b.name));
        const out = {
            id: vendor,
            name: `${vendor} (generated from zigbee-herdsman-converters ${ZHC_VERSION})`,
            generated: true,
            devices,
        };
        const outFile = path.join(OUT_DIR, `${vendor}.json`);
        if (devices.length) fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + "\n");
        else if (fs.existsSync(outFile)) fs.unlinkSync(outFile); // nothing ZHA doesn't already offer
        fs.writeFileSync(path.join(__dirname, `${vendor}.skipped.json`), JSON.stringify(skipped, null, 1) + "\n");
        const nSettings = devices.reduce((n, d) => n + d.settings.length, 0);
        console.log(`${vendor}: ${devices.length} devices, ${nSettings} settings, ${Object.keys(skipped).length} models with skips`);
    }
    process.exit(0); // some converters leave timers running
})();
