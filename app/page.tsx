"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";

type Row = {
  Name: string;
  "Work Email": string;
  "Manager Email": string;
  Team: string;
  Pod?: string;
  Location: string;
  "Photo URL": string;
};

function normalizeEmail(v: string) {
  return (v || "").trim().toLowerCase();
}

function normalizePod(v: string) {
  // normalize quotes/spaces/case a bit so FO variations don't split pods
  return (v || "")
    .trim()
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ");
}

function ensureHttps(url: string) {
  const u = (url || "").trim();
  if (!u) return "";
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  return `https://${u}`;
}

function requiredColsMissing(headers: string[]) {
  const required = ["Name", "Work Email", "Manager Email", "Team", "Location", "Photo URL"];
  const set = new Set(headers);
  return required.filter((c) => !set.has(c));
}

type NodeT = {
  id: string;
  parentId: string | null;
  name: string;
  email: string;
  team: string;
  pod: string;
  location: string;
  photoUrl: string;
};

export default function ClientPage() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartObjRef = useRef<any>(null);

  const [isEdit, setIsEdit] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string>("");

  // layout toggle
  const [viewMode, setViewMode] = useState<"hierarchy" | "pod">("hierarchy");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsEdit(params.get("edit") === "1");
  }, []);

  // Load shared CSV from server on first load
  useEffect(() => {
    fetch("/api/org")
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.text();
      })
      .then((text) => {
        Papa.parse<Row>(text, {
          header: true,
          skipEmptyLines: true,
          complete: (res) => setRows((res.data || []) as Row[]),
          error: (err: unknown) =>
            setError(err instanceof Error ? err.message : String(err)),
        });
      })
      .catch(() => {
        // first run: no CSV uploaded yet
      });
  }, []);

  const nodes: NodeT[] = useMemo(() => {
    const built: NodeT[] = rows.map((r, i) => {
      const workEmail = String(r["Work Email"] || "").trim();
      const name = String(r.Name || "").trim();
      const pod = normalizePod(String(r.Pod || ""));

      return {
        id: workEmail ? normalizeEmail(workEmail) : `name:${name.toLowerCase()}:${i}`,
        parentId: normalizeEmail(r["Manager Email"]) || null,
        name: name || workEmail || "(no name)",
        email: workEmail,
        team: String(r.Team || "").trim(),
        pod,
        location: String(r.Location || "").trim(),
        photoUrl:
          ensureHttps(r["Photo URL"] || "") ||
          `https://ui-avatars.com/api/?background=eee&color=555&name=${encodeURIComponent(
            name || "User"
          )}`,
      };
    });

    const ids = new Set(built.map((n) => n.id));
    return built.map((n) => ({
      ...n,
      parentId: n.parentId && ids.has(n.parentId) ? n.parentId : null,
    }));
  }, [rows]);

  // Render chart when nodes change
  useEffect(() => {
    if (!chartRef.current) return;

    if (!nodes.length) {
      chartRef.current.innerHTML = "";
      return;
    }

    chartRef.current.innerHTML = "";

    let cancelled = false;

    (async () => {
      const mod = await import("d3-org-chart");
      const OrgChart = (mod as any).OrgChart;

      if (cancelled || !chartRef.current) return;

      const LILA = "#7C3AED";
      const LILA_BG = "#F5F3FF";
      const LILA_BADGE_BG = "#EDE9FE";
      const TEXT_DARK = "#111827";
      const TEXT_MID = "#374151";
      const TEXT_LIGHT = "#6B7280";

      const chart = new OrgChart()
        .container(chartRef.current)
        .data(nodes)
        .nodeWidth(() => (viewMode === "pod" ? 340 : 320))
        .nodeHeight(() => 110)
        .childrenMargin(() => 50)
        .compactMarginBetween(() => 35)
        .compactMarginPair(() => 80)
        .compact(viewMode === "pod") // pod mode is a bit more compact, feels grouped
        .nodeSort((a: any, b: any) => {
          // IMPORTANT: hierarchy stays same; we only sort siblings-ish by pod+name
          if (viewMode !== "pod") return 0;
          const pa = String(a.data.pod || "").toLowerCase();
          const pb = String(b.data.pod || "").toLowerCase();
          if (pa < pb) return -1;
          if (pa > pb) return 1;
          const na = String(a.data.name || "").toLowerCase();
          const nb = String(b.data.name || "").toLowerCase();
          return na.localeCompare(nb);
        })
        .nodeContent((d: any) => {
          const p: NodeT = d.data;

          const img = p.photoUrl
            ? `<img src="${p.photoUrl}" crossorigin="anonymous"
                 style="width:64px;height:64px;border-radius:16px;object-fit:cover;border:1px solid rgba(0,0,0,0.10)" />`
            : `<div style="width:64px;height:64px;border-radius:16px;background:rgba(0,0,0,0.06);
                 display:flex;align-items:center;justify-content:center;font-weight:800;color:${TEXT_DARK};">
               ${String(p.name).trim().slice(0, 1).toUpperCase()}
             </div>`;

          // Pod badge: top-right, doesn't add a new "line"
          const podBadge = p.pod
            ? `<div style="
                position:absolute;top:10px;right:12px;
                font-size:11px;font-weight:800;color:${LILA};
                background:${LILA_BADGE_BG};
                border:1px solid rgba(124,58,237,0.18);
                padding:2px 8px;border-radius:999px;
                max-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
              ">${p.pod}</div>`
            : "";

          return `
            <div style="
              width:${viewMode === "pod" ? 340 : 320}px;height:110px;
              background:${LILA_BG};
              border:1px solid rgba(0,0,0,0.10);
              border-left:6px solid ${LILA};
              border-radius:16px;
              box-shadow:0 3px 14px rgba(0,0,0,0.06);
              padding:12px;display:flex;gap:12px;align-items:center;
              position:relative;
            ">
              ${podBadge}
              ${img}
              <div style="display:flex;flex-direction:column;gap:6px;min-width:0;flex:1;padding-right:8px;">
                <div style="
                  font-weight:900;font-size:15px;line-height:1.1;color:${TEXT_DARK};
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">${p.name}</div>

                <div style="
                  font-size:12px;font-weight:800;color:${TEXT_DARK};
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">${p.team}</div>

                <div style="
                  font-size:12px;font-weight:700;color:${TEXT_MID};
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">${p.location}</div>

                <div style="
                  font-size:11px;font-weight:700;color:${TEXT_LIGHT};
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">${p.email}</div>
              </div>
            </div>
          `;
        })
        .render();

      chartObjRef.current = chart;
    })();

    return () => {
      cancelled = true;
    };
  }, [nodes, viewMode]);

  async function uploadCsvToServer(file: File) {
    setError("");

    const pw = prompt("Admin password?");
    if (!pw) return;

    const fd = new FormData();
    fd.append("file", file);

    const res = await fetch("/api/org", {
      method: "POST",
      headers: { "x-admin-password": pw },
      body: fd,
    });

    if (!res.ok) {
      setError(`Upload failed: ${await res.text()}`);
      return;
    }

    const csv = await (await fetch("/api/org")).text();
    Papa.parse<Row>(csv, {
      header: true,
      skipEmptyLines: true,
      complete: (r) => setRows((r.data || []) as Row[]),
      error: (err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
    });
  }

  return (
    <div style={{ padding: 20, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto" }}>
      <h1 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 16px 0" }}>
        Aspora Organisational Chart
      </h1>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        {isEdit && (
          <input
            type="file"
            accept=".csv"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (!file.name.toLowerCase().endsWith(".csv")) {
                setError("Please upload a .csv file.");
                return;
              }
              await uploadCsvToServer(file);
            }}
          />
        )}

        <button onClick={() => chartObjRef.current?.fit()} style={{ padding: "8px 12px" }}>
          Fit
        </button>
        <button onClick={() => chartObjRef.current?.expandAll()} style={{ padding: "8px 12px" }}>
          Expand
        </button>
        <button onClick={() => chartObjRef.current?.collapseAll()} style={{ padding: "8px 12px" }}>
          Collapse
        </button>

        <div style={{ width: 1, height: 26, background: "rgba(0,0,0,0.15)", margin: "0 6px" }} />

        <button
          onClick={() => setViewMode((v) => (v === "hierarchy" ? "pod" : "hierarchy"))}
          style={{ padding: "8px 12px", fontWeight: 800 }}
        >
          Layout: {viewMode === "hierarchy" ? "Hierarchy" : "Pod"}
        </button>
      </div>

      {error ? (
        <div style={{ color: "#b00020", fontWeight: 800, marginBottom: 12 }}>{error}</div>
      ) : null}

      <div
        style={{
          border: "1px solid rgba(0,0,0,0.12)",
          borderRadius: 16,
          background: "white",
          padding: 12,
          minHeight: 650,
          overflow: "hidden",
        }}
      >
        <div ref={chartRef} />
      </div>

      <div style={{ marginTop: 10, opacity: 0.7, fontSize: 12 }}>
        CSV headers expected: Name, Work Email, Manager Email, Team, Location, Photo URL (optional: Pod)
      </div>
    </div>
  );
}

