/**
 * @worldwideview/wwv-plugin-mentat-home
 *
 * Renders entities from a running Mentat home-security instance on the WWV
 * globe. The plugin manages its own WebSocket to Mentat's `/api/bridge/wwv/*`
 * surface — Mentat is *not* a WWV data-engine seeder, so we deliberately
 * bypass `streamUrl` + the data-engine WS runner. Entities flow into the
 * platform via `ctx.onDataUpdate(entityList)`.
 *
 * Bridge contract is defined in mentat/backend/api/bridge.py. Wire format
 * documented there is the source of truth — keep this file's frame handlers
 * in lockstep with it.
 */

import type {
    WorldPlugin,
    GeoEntity,
    CesiumEntityOptions,
    LayerConfig,
    PluginContext,
    PluginCategory,
    TimeRange,
} from "@worldwideview/wwv-plugin-sdk";

// ─── Config ───────────────────────────────────────────────────────

const DEFAULT_MANIFEST_URL = "http://localhost:8000/api/bridge/wwv/manifest";
const PLUGIN_SCHEMA_VERSION = 1;

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const SNAPSHOT_REFETCH_AFTER_GAPS_MS = 60_000;

// Bridge frame types (mirrors mentat/backend/api/bridge.py)
type BridgeFrame =
    | { type: "hello"; schemaVersion: number; serverTime: string; pluginId: string }
    | { type: "entity"; entity: GeoEntity }
    | { type: "delete"; id: string }
    | { type: "ping" };

interface BridgeManifest {
    id: string;
    name: string;
    version: string;
    schemaVersion: number;
    snapshotUrl: string;
    streamUrl: string;
    homeAnchor: { lat: number; lon: number; label: string } | null;
}

interface BridgeSnapshot {
    schemaVersion: number;
    serverTime: string;
    entities: GeoEntity[];
}

type MentatEntityKind =
    | "camera"
    | "zone"
    | "person_known"
    | "person_unknown"
    | "vehicle"
    | "event"
    | "alert_active"
    | "alert_resolved"
    | "sensor";

// ─── Plugin ───────────────────────────────────────────────────────

export default class MentatHomePlugin implements WorldPlugin {
    id = "mentat-home";
    name = "Mentat Home Security";
    description = "Live property surveillance from your Mentat instance.";
    icon = "Home";
    category: PluginCategory = "custom";
    version = "0.1.0";

    private ctx: PluginContext | null = null;
    private ws: WebSocket | null = null;
    private reconnectDelay = RECONNECT_INITIAL_MS;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private manifest: BridgeManifest | null = null;
    private entities = new Map<string, GeoEntity>();
    private lastFrameAt = 0;
    private destroyed = false;

    // ─── Lifecycle ────────────────────────────────────────────────

    async initialize(ctx: PluginContext): Promise<void> {
        this.ctx = ctx;
        this.destroyed = false;

        const manifestUrl = this.resolveManifestUrl(ctx);
        try {
            this.manifest = await this.fetchJson<BridgeManifest>(manifestUrl);
        } catch (err) {
            ctx.onError(new Error(`mentat-home: failed to fetch manifest at ${manifestUrl}: ${(err as Error).message}`));
            return;
        }

        if (this.manifest.schemaVersion !== PLUGIN_SCHEMA_VERSION) {
            ctx.onError(new Error(
                `mentat-home: schema mismatch — plugin expects ${PLUGIN_SCHEMA_VERSION}, bridge serves ${this.manifest.schemaVersion}.`,
            ));
        }

        try {
            const snap = await this.fetchJson<BridgeSnapshot>(this.manifest.snapshotUrl);
            for (const e of snap.entities) this.entities.set(e.id, e);
            this.pushUpdate();
        } catch (err) {
            ctx.onError(new Error(`mentat-home: snapshot fetch failed: ${(err as Error).message}`));
        }

        this.connectStream();
    }

    destroy(): void {
        this.destroyed = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        if (this.ws) {
            try { this.ws.close(1000, "plugin destroy"); } catch { /* noop */ }
            this.ws = null;
        }
        this.entities.clear();
    }

    // ─── WWV plugin contract ──────────────────────────────────────

    async fetch(_timeRange: TimeRange): Promise<GeoEntity[]> {
        // All data flows through the WS / snapshot path; nothing to fetch
        // on demand. Returning the current in-memory list keeps the WWV
        // engine's polling stub happy if it ever calls us.
        return Array.from(this.entities.values());
    }

    getPollingInterval(): number {
        return 0; // WS-driven, never polled
    }

    getLayerConfig(): LayerConfig {
        return {
            color: "#22d3ee",          // Mentat accent cyan
            clusterEnabled: false,     // entities cluster near home; little payoff to clustering
            clusterDistance: 40,
        };
    }

    renderEntity(entity: GeoEntity): CesiumEntityOptions {
        const kind = (entity.properties?.type as MentatEntityKind | undefined) ?? "event";
        return this.renderFor(kind);
    }

    private renderFor(kind: MentatEntityKind): CesiumEntityOptions {
        // SDK rule (CLAUDE.md): never mix `size`/`outlineWidth`/`outlineColor`
        // onto a billboard — GPU silently clips. Each branch returns a
        // homogeneous shape.
        switch (kind) {
            case "camera":
                return { type: "billboard", iconUrl: cameraIconDataUrl(), iconScale: 0.6, color: "#fbbf24" };
            case "vehicle":
                return { type: "billboard", iconUrl: vehicleIconDataUrl(), iconScale: 0.6, color: "#38bdf8" };
            case "alert_active":
                return { type: "billboard", iconUrl: alertIconDataUrl(), iconScale: 0.8, color: "#f87171" };
            case "alert_resolved":
                return { type: "billboard", iconUrl: alertIconDataUrl(), iconScale: 0.5, color: "#64748b" };
            case "zone":
                // Zones are areas; rendered as label points until polygon support lands in v2.
                return { type: "point", color: "#64748b", size: 6, outlineColor: "#94a3b8", outlineWidth: 1 };
            case "person_known":
                return { type: "point", color: "#34d399", size: 12, outlineColor: "#ffffff", outlineWidth: 2 };
            case "person_unknown":
                return { type: "point", color: "#f87171", size: 12, outlineColor: "#ffffff", outlineWidth: 2 };
            case "sensor":
                return { type: "point", color: "#fbbf24", size: 6, outlineColor: "#1a232f", outlineWidth: 1 };
            case "event":
            default:
                return { type: "point", color: "#a78bfa", size: 8, outlineColor: "#ffffff", outlineWidth: 1 };
        }
    }

    // ─── Network plumbing ─────────────────────────────────────────

    private resolveManifestUrl(ctx: PluginContext): string {
        // Surfaced by WWV runtime from NEXT_PUBLIC_WWV_PLUGIN_MENTAT_HOME_MANIFEST_URL
        const fromEnv = ctx.env?.MENTAT_HOME_MANIFEST_URL;
        if (fromEnv && fromEnv.length > 0) return fromEnv;
        return DEFAULT_MANIFEST_URL;
    }

    private async fetchJson<T>(url: string): Promise<T> {
        const res = await fetch(url, { headers: { "accept": "application/json" } });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
        return (await res.json()) as T;
    }

    private connectStream(): void {
        if (this.destroyed || !this.manifest) return;

        const url = this.manifest.streamUrl;
        let ws: WebSocket;
        try {
            ws = new WebSocket(url);
        } catch (err) {
            this.ctx?.onError(new Error(`mentat-home: failed to construct WS for ${url}: ${(err as Error).message}`));
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;

        ws.onopen = () => {
            this.reconnectDelay = RECONNECT_INITIAL_MS; // reset backoff on success
            this.lastFrameAt = Date.now();
        };

        ws.onmessage = (event: MessageEvent<string>) => {
            this.lastFrameAt = Date.now();
            let frame: BridgeFrame;
            try {
                frame = JSON.parse(event.data) as BridgeFrame;
            } catch {
                return; // ignore malformed frames; bridge guarantees JSON
            }
            this.handleFrame(frame);
        };

        ws.onerror = () => {
            // Surfacing per-error noise to the user pollutes the UI; the
            // close handler (always fires on error) drives reconnect.
        };

        ws.onclose = () => {
            this.ws = null;
            if (!this.destroyed) this.scheduleReconnect();
        };
    }

    private scheduleReconnect(): void {
        if (this.destroyed) return;
        if (this.reconnectTimer) return;
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            // If we've been disconnected long enough, re-snapshot before
            // streaming again — otherwise local state drifts from the bridge.
            const gap = Date.now() - this.lastFrameAt;
            if (gap > SNAPSHOT_REFETCH_AFTER_GAPS_MS && this.manifest && this.ctx) {
                this.fetchJson<BridgeSnapshot>(this.manifest.snapshotUrl)
                    .then(snap => {
                        this.entities.clear();
                        for (const e of snap.entities) this.entities.set(e.id, e);
                        this.pushUpdate();
                    })
                    .catch(err => this.ctx?.onError(new Error(`mentat-home: re-snapshot failed: ${(err as Error).message}`)))
                    .finally(() => this.connectStream());
            } else {
                this.connectStream();
            }
        }, delay);
    }

    private handleFrame(frame: BridgeFrame): void {
        switch (frame.type) {
            case "hello":
                // Sanity-check the server-declared schemaVersion against our own.
                if (frame.schemaVersion !== PLUGIN_SCHEMA_VERSION) {
                    this.ctx?.onError(new Error(
                        `mentat-home: stream schema ${frame.schemaVersion} != plugin ${PLUGIN_SCHEMA_VERSION}`,
                    ));
                }
                return;
            case "ping":
                // Bridge keepalive; no response required by current protocol.
                return;
            case "entity":
                if (!frame.entity?.id) return;
                this.entities.set(frame.entity.id, frame.entity);
                this.pushUpdate();
                return;
            case "delete":
                if (this.entities.delete(frame.id)) this.pushUpdate();
                return;
        }
    }

    private pushUpdate(): void {
        this.ctx?.onDataUpdate(Array.from(this.entities.values()));
    }
}

// ─── Inline icon helpers ──────────────────────────────────────────
//
// Each renders a small lucide-style glyph wrapped in a tinted circle so
// the icon is legible against any terrain. Inline SVG keeps the plugin
// self-contained (no asset pipeline / CDN dependency).

function svgDataUrl(svg: string): string {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function badgeSvg(inner: string, bg: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
        <circle cx="16" cy="16" r="14" fill="${bg}" stroke="rgba(255,255,255,0.18)" stroke-width="1"/>
        <g transform="translate(6,6)" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</g>
    </svg>`;
}

function cameraIconDataUrl(): string {
    return svgDataUrl(badgeSvg(
        `<path d="M3 7h14v10H3z"/><path d="M17 10l3-2v8l-3-2z"/>`,
        "rgba(20,28,42,0.92)",
    ));
}

function vehicleIconDataUrl(): string {
    return svgDataUrl(badgeSvg(
        `<path d="M3 13l2-5h10l2 5"/><path d="M3 13v4h14v-4"/><circle cx="6" cy="17" r="1.5"/><circle cx="14" cy="17" r="1.5"/>`,
        "rgba(20,28,42,0.92)",
    ));
}

function alertIconDataUrl(): string {
    return svgDataUrl(badgeSvg(
        `<path d="M10 2L1 18h18z"/><path d="M10 8v5"/><circle cx="10" cy="15.5" r="0.6" fill="white"/>`,
        "rgba(60,15,15,0.92)",
    ));
}
