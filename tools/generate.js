#!/usr/bin/env node
// Generate ZHA Device Settings definitions from zigbee-herdsman-converters.
//
// Rather than re-implementing Z2M's converters, we *run* them: every settable
// expose is fed each of its possible values through its toZigbee converter
// against a mock device that records the ZCL writes. The recording is the
// ground truth for which endpoint/cluster/attribute/type/value ZHA must send.
//
// Usage: node generate.js [vendorFile ...]   (default: lumi)
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
const SET = 0b010;

// Settable exposes that are everyday controls ZHA already provides as entities.
const RUNTIME_PROPS = new Set([
    "state", "brightness", "color", "color_temp", "color_xy", "color_hs", "position", "tilt",
    "effect", "occupied_heating_setpoint", "current_heating_setpoint", "system_mode", "running_state",
    "fan_mode", "alarm", "volume", "melody", "duration", "identify", "do_not_disturb_start",
]);

// ---------- mock device ----------

const MOCK_IEEES = ["0x00158d0001000000", "0x54ef44100a0b0c0d"];

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
        async write(cluster, payload, options = {}) {
            writes.push({endpoint: ID, cluster, payload, options});
        },
        async read() { return {}; },
        async command(cluster, command, payload, options = {}) {
            writes.push({endpoint: ID, cluster, command, payload, options});
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

// Turn recorded writes into flat [{endpoint, cluster, attribute, type, manufacturer, value}]
function flattenWrites(raw, device) {
    const out = [];
    for (const w of raw) {
        if (w.command) return null; // command-based setting: not supported (yet)
        const mfr = w.options.manufacturerCode;
        let cluster;
        try {
            cluster = resolveCluster(w.cluster, device, mfr);
        } catch (e) {
            return null;
        }
        for (const [key, v] of Object.entries(w.payload)) {
            const attr = attrByKey(cluster, key);
            let type = attr && attr.type;
            let value = v;
            if (v && typeof v === "object" && !Array.isArray(v) && !Buffer.isBuffer(v) && "value" in v) {
                type = v.type;
                value = v.value;
            }
            if (!attr || attr.ID === undefined || type === undefined) return null;
            if (Buffer.isBuffer(value)) value = [...value];
            const bytesType = type === 0x41 || type === 0x43;
            // Z2M sometimes passes [n] for scalar types and relies on JS coercion.
            if (!bytesType && Array.isArray(value) && value.length === 1) value = value[0];
            if (typeof value === "boolean") value = value ? 1 : 0;
            const isFloat = type === 0x38 || type === 0x39 || type === 0x3a;
            const isBytes = bytesType && Array.isArray(value) && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);
            const ok = isBytes || (isFloat ? typeof value === "number" : Number.isInteger(value));
            if (!ok) return null;
            out.push({
                endpoint: w.endpoint,
                cluster: cluster.ID,
                attribute: attr.ID,
                type,
                manufacturer: mfr ?? (cluster.manufacturerCode !== undefined && attr.manufacturerCode === undefined ? cluster.manufacturerCode : attr.manufacturerCode) ?? null,
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

const humanize = (s) => String(s).replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

async function capture(def, zigbeeModel, feature, conv, value, ieee) {
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
        device, mapped: def, options: {}, state: {}, logger: quiet,
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
        if (r2.error || JSON.stringify(r2.writes) !== JSON.stringify(r.writes)) return {skip: "device-specific payload"};
        results.push({value: v, writes: r.writes});
    }

    const single = results.every((r) => r.writes.length === 1 && typeof r.writes[0].value === "number") &&
        results.every((r) => sameTarget(r.writes[0], results[0].writes[0]));
    const target = single ? (({value, ...t}) => t)(results[0].writes[0]) : null;

    if (feature.type === "numeric") {
        if (!single) return {skip: "numeric without a single attribute"};
        const [a, b, c] = results;
        const ra = a.writes[0].value, rb = b.writes[0].value, rc = c.writes[0].value;
        const scale = b.value === a.value ? 1 : (rb - ra) / (b.value - a.value);
        const offset = ra - scale * a.value;
        if (Math.abs(scale * c.value + offset - rc) > 1) return {skip: "non-linear numeric"};
        return {setting: {...base, control: "number", target, min: feature.value_min ?? null, max: feature.value_max ?? null,
            step: feature.value_step ?? 1, unit: feature.unit || null, scale: +scale.toFixed(6), offset: +offset.toFixed(6)}};
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
            if (r.setting) settings.push(r.setting);
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
    const vendors = process.argv.slice(2).length ? process.argv.slice(2) : ["lumi"];
    for (const vendor of vendors) {
        const {devices, skipped} = await processVendor(vendor);
        devices.sort((a, b) => a.name.localeCompare(b.name));
        const out = {
            id: vendor,
            name: `${vendor} (generated from zigbee-herdsman-converters ${ZHC_VERSION})`,
            generated: true,
            devices,
        };
        fs.writeFileSync(path.join(OUT_DIR, `${vendor}.json`), JSON.stringify(out, null, 1) + "\n");
        fs.writeFileSync(path.join(__dirname, `${vendor}.skipped.json`), JSON.stringify(skipped, null, 1) + "\n");
        const nSettings = devices.reduce((n, d) => n + d.settings.length, 0);
        console.log(`${vendor}: ${devices.length} devices, ${nSettings} settings, ${Object.keys(skipped).length} models with skips`);
    }
    process.exit(0); // some converters leave timers running
})();
