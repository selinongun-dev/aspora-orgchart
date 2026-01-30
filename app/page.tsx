"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import * as d3 from "d3";

type Row = {
  Name: string;
  "Work Email": string;
  "Manager Email": string;
  Team?: string;
  Pod?: string;
  Location?: string;
  "Photo URL"?: string;
};

function normalizeEmail(v: string) {
  return (v || "").trim().toLowerCase();
}

function ensureHttps(url: string) {
  const u = (url || "").trim();
  if (!u) return "";
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  return `https://${u}`;
}

// Pod normalize: CSV’deki küçük farkları tek isme indir (çok kritik!)
function normalizePod(v: string) {
  const raw = (v || "").trim();
  if (!raw) return "";

  const x = raw
    .replace(/’/g, "'") // curly apostrophe -> normal
    .replace(/\s+/g, " ")
    .trim();

  const lower = x.toLowerCase();

  // örnek mapping: ihtiyacına göre genişlet
  if (lower === "fo") return "Founder's Office";
  if (lower === "founders office") return "Founder's Office";
  if (lower === "founder's office") return "Founder's Office";

  return x;
}

export default function ClientPage() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartObjRef = useRef<any>(null);

  const [isEdit, setIsEdit] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsEdit(params.get("edit") === "1");
  }, []);

  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string>("");

  // shared csv load
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
      .catch(() => {});
  }, []);

  const NODE_W = 320;
  const NODE_H = 120;

  const nodes = useMemo(() => {
    const built = rows.map((r, i) => {
      const workEmail = String(r["Work Email"] || "").trim();
      const name = String(r.Name || "").trim();

      return {
        id: workEmail ? normalizeEmail(workEmail) : `name:${name.toLowerCase()}:${i}`,
        parentId: normalizeEmail(r["Manager Email"]) || null,

        name: name || workEmail || "(no name)",
        email: workEmail,

        team: String(r.Team || "").trim(),
        pod: normalizePod(String(r.Pod || "")),

        location: String(r.Location || "").trim(),
        photoUrl:
          ensureHttps(String(r["Photo URL"] || "")) ||
          `https://ui-avatars.com/api/?background=eee&color=555&name=${encodeURIComponent(
            name || "User"
          )}`,
      };
    });

    // manager id not in dataset => root
    const ids = new Set(built.map((n) => n.id));
    return built.map((n) => ({
      ...n,
      parentId: n.parentId && ids.has(n.parentId) ? n.parentId : null,
    }));
  }, [rows]);

  // helper: parse translate(x,y)
  function parseTranslate(transform: string | null) {
    if (!transform) return null;
    const m = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(transform);
    if (!m) return null;
    return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
  }

  // Draw pod grouping rectangles behind nodes (visual grouping, NOT hierarchy)
  function drawPodGroups() {
    if (!chartRef.current) return;

    const root = d3.select(chartRef.current);
    const svg = root.select("svg");
    if (svg.empty()) return;

    // Remove old layer
    svg.selectAll("g.pod-group-layer").remove();

    // Create a layer behind nodes
    const layer = svg.insert("g", ":first-child")
      .attr("class", "pod-group-layer")
      .style("pointer-events", "none");

    // Collect node positions from rendered DOM
    const rendered: Array<{
      id: string;
      parentId: string | null;
      pod: string;
      x: number;
      y: number;
    }> = [];

    root.selectAll("g.node").each(function () {
      const g = d3.select(this);
      const datum: any = g.datum();
      const t = parseTranslate(g.attr("transform"));
      if (!datum?.data || !t) return;

      rendered.push({
        id: datum.data.id,
        parentId: datum.data.parentId ?? null,
        pod: datum.data.pod ?? "",
        x: t.x,
        y: t.y,
      });
    });

    if (!rendered.length) return;

    // Group by (parentId + pod) — only for children that have a pod
    const byParentPod = d3.group(
      rendered.filter((n) => n.parentId && n.pod),
      (n) => n.parentId as string,
      (n) => n.pod as string
    );

    const PADDING = 18;
    const LABEL_H = 22;

    for (const [parentId, pods] of byParentPod.entries()) {
      // If parent has only 1 pod group, still draw (optional). İstersen burada filtreleyebilirsin.
      for (const [pod, items] of pods.entries()) {
        if (items.length < 2) continue; // tek kişi için kutu çizme (istersen kaldır)

        const minX = d3.min(items, (d) => d.x) ?? 0;
        const minY = d3.min(items, (d) => d.y) ?? 0;
        const maxX = d3.max(items, (d) => d.x) ?? 0;
        const maxY = d3.max(items, (d) => d.y) ?? 0;

        const x = minX - PADDING;
        const y = minY - PADDING - LABEL_H;
        const w = (maxX - minX) + NODE_W + PADDING * 2;
        const h = (maxY - minY) + NODE_H + PADDING * 2 + LABEL_H;

        // Group container
        const g = layer.append("g").attr("transform", `translate(${x},${y})`);

        // Background rect
        g.append("rect")
          .attr("width", w)
          .attr("height", h)
          .attr("rx", 18)
          .attr("ry", 18)
          .attr("fill", "rgba(99,102,241,0.06)")      // çok hafif indigo
          .attr("stroke", "rgba(99,102,241,0.25)")   // hafif border
          .attr("stroke-width", 1.2);

        // Label chip
        g.append("rect")
          .attr("x", 14)
          .attr("y", 10)
          .attr("width", Math.min(220, 12 + pod.length * 7.2))
          .attr("height", 22)
          .attr("rx", 999)
          .attr("ry", 999)
          .attr("fill", "rgba(99,102,241,0.14)")
          .attr("stroke", "rgba(99,102,241,0.20)")
          .attr("stroke-width", 1);

        g.append("text")
          .attr("x", 24)
          .attr("y", 26)
          .attr("font-size", 12)
          .attr("font-weight", 800)
          .attr("fill", "#3730A3")
          .text(pod);
      }
    }
  }

  // Render chart
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

      const chart = new OrgChart()
        .container(chartRef.current)
        .data(nodes)
        .nodeWidth(() => NODE_W)
        .nodeHeight(() => NODE_H)
        .childrenMargin(() => 55)
        .compactMarginBetween(() => 40)
        .compactMarginPair(() => 90)
        .nodeContent((d: any) => {
          const p = d.data;

          const img = p.photoUrl
            ? `<img src="${p.photoUrl}" crossorigin="anonymous"
                 style="width:64px;height:64px;border-radius:16px;object-fit:cover;border:1px solid rgba(0,0,0,0.12)" />`
            : `<div style="width:64px;height:64px;border-radius:16px;background:rgba(0,0,0,0.06);
                 display:flex;align-items:center;justify-content:center;font-weight:800;">
                 ${String(p.name).trim().slice(0, 1).toUpperCase()}
               </div>`;

          // sadece 4 satır: name/team/country/email
          return `
            <div style="
              width:${NODE_W}px;height:${NODE_H}px;background:#fff;border:1px solid rgba(0,0,0,0.12);
              border-radius:16px;box-shadow:0 3px 14px rgba(0,0,0,0.07);
              padding:12px;display:flex;gap:12px;align-items:center;
            ">
              ${img}
              <div style="display:flex;flex-direction:column;gap:6px;min-width:0;flex:1;">
                <div style="font-weight:900;font-size:16px;line-height:1.15;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${p.name}
                </div>
                <div style="font-size:13px;font-weight:800;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${p.team || ""}
                </div>
                <div style="font-size:12px;font-weight:700;color:#374151;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${p.location || ""}
                </div>
                <div style="font-size:12px;font-weight:700;color:#6B7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${p.email || ""}
                </div>
              </div>
            </div>
          `;
        })
        .render();

      chartObjRef.current = chart;

      // Draw pod groups after render (DOM oluşsun)
      requestAnimationFrame(() => drawPodGroups());
    })();

    return () => {
      cancelled = true;
    };
  }, [nodes]);

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

  // Wrap buttons to redraw groups after expand/collapse/fit
  function afterAction(fn: () => void) {
    fn();
    // render sonrası kutuları yeniden çiz
    setTimeout(() => drawPodGroups(), 60);
  }

  return (
    <div style={{ padding: 20, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto" }}>
      <h1 style={{ fontSize: 26, fontWeight: 800, margin: "0 0 16px 0" }}>
        Aspora Organisational Chart
      </h1>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
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

        <button onClick={() => afterAction(() => chartObjRef.current?.fit())} style={{ padding: "8px 12px" }}>
          Fit
        </button>
        <button onClick={() => afterAction(() => chartObjRef.current?.expandAll())} style={{ padding: "8px 12px" }}>
          Expand
        </button>
        <button onClick={() => afterAction(() => chartObjRef.current?.collapseAll())} style={{ padding: "8px 12px" }}>
          Collapse
        </button>
      </div>

      {error ? (
        <div style={{ color: "#b00020", fontWeight: 700, marginBottom: 12 }}>{error}</div>
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
