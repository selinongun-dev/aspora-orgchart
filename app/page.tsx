"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";

type Row = {
  Name: string;
  "Work Email": string;
  "Manager Email": string;
  Team?: string;
  Pod?: string; // ✅ new
  Location?: string;
  "Photo URL"?: string;
};

type NodeData = {
  type: "pod" | "person";
  id: string;
  parentId: string | null;

  // shared
  name: string;

  // person-only
  email?: string;
  team?: string;
  pod?: string;
  location?: string;
  photoUrl?: string;
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

function sanitizeIdPart(v: string) {
  return (v || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_.:]/g, "");
}

export default function ClientPage() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartObjRef = useRef<any>(null);

  const [isEdit, setIsEdit] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string>("");

  // Determine edit mode on client
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsEdit(params.get("edit") === "1");
  }, []);

  // Load shared CSV from server on first load (view-only users included)
  useEffect(() => {
    fetch("/api/org")
      .then(async (r) => {
        if (r.status === 204) return ""; // no CSV yet
        if (!r.ok) throw new Error(await r.text());
        return r.text();
      })
      .then((text) => {
        if (!text) return;
        Papa.parse<Row>(text, {
          header: true,
          skipEmptyLines: true,
          complete: (res) => setRows((res.data || []) as Row[]),
          error: (err: unknown) =>
            setError(err instanceof Error ? err.message : String(err)),
        });
      })
      .catch(() => {
        // First run: no CSV uploaded yet (normal)
      });
  }, []);

  /**
   * Build org chart nodes.
   * - Real reporting hierarchy stays intact (manager edges win).
   * - People whose manager is missing are grouped under their Pod header.
   * - If a person has neither a valid manager nor a Pod, they become top-level.
   */
  const nodes = useMemo<NodeData[]>(() => {
    // 1) Build all person nodes first
    const people: NodeData[] = rows.map((r, i) => {
      const workEmailRaw = String(r["Work Email"] || "").trim();
      const name = String(r.Name || "").trim();
      const pod = String(r.Pod || "").trim();

      const id = workEmailRaw
        ? normalizeEmail(workEmailRaw)
        : `name:${sanitizeIdPart(name)}:${i}`;

      const photoUrl =
        ensureHttps(String(r["Photo URL"] || "")) ||
        `https://ui-avatars.com/api/?background=eee&color=555&name=${encodeURIComponent(
          name || "User"
        )}`;

      return {
        type: "person",
        id,
        parentId: normalizeEmail(String(r["Manager Email"] || "")) || null,
        name: name || workEmailRaw || "(no name)",
        email: workEmailRaw,
        team: String(r.Team || "").trim(),
        pod,
        location: String(r.Location || "").trim(),
        photoUrl,
      };
    });

    const personIds = new Set(people.map((p) => p.id));

    // 2) Create Pod header nodes
    const podNames = Array.from(
      new Set(people.map((p) => (p.pod || "").trim()).filter(Boolean))
    );

    const podNodes: NodeData[] = podNames.map((podName) => ({
      type: "pod",
      id: `pod:${sanitizeIdPart(podName)}`,
      parentId: null,
      name: podName,
    }));

    const podIdByName = new Map(podNodes.map((p) => [p.name, p.id]));

    // 3) Fix parent links
    const finalPeople = people.map((p) => {
      const mgr = p.parentId;

      // If manager exists within dataset, keep real hierarchy
      if (mgr && personIds.has(mgr)) return p;

      // Otherwise group under pod header if available
      const podParent = p.pod ? podIdByName.get(p.pod) : null;
      return {
        ...p,
        parentId: podParent || null,
      };
    });

    return [...podNodes, ...finalPeople];
  }, [rows]);

  // Render chart when nodes change
  useEffect(() => {
    if (!chartRef.current) return;

    // clear chart if no data
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
        .nodeWidth(() => 320)
        .nodeHeight(() => 128)
        .childrenMargin(() => 50)
        .compactMarginBetween(() => 35)
        .compactMarginPair(() => 80)
        .nodeContent((d: any) => {
          const p: NodeData = d.data;

          // ✅ Pod header card (grouping)
          if (p.type === "pod") {
            return `
              <div style="
                width:320px;height:64px;background:#0F172A;color:white;
                border-radius:14px;display:flex;align-items:center;justify-content:center;
                font-weight:900;font-size:16px;letter-spacing:0.2px;
                box-shadow:0 6px 18px rgba(0,0,0,0.12);
              ">
                ${p.name}
              </div>
            `;
          }

          // ✅ Person card (Team is under Name, Pod NOT shown here)
          const img = p.photoUrl
            ? `<img src="${p.photoUrl}" crossorigin="anonymous"
                   style="width:64px;height:64px;border-radius:16px;object-fit:cover;border:1px solid rgba(0,0,0,0.12)" />`
            : `<div style="width:64px;height:64px;border-radius:16px;background:rgba(0,0,0,0.06);
                   display:flex;align-items:center;justify-content:center;font-weight:800;">
                 ${String(p.name).trim().slice(0, 1).toUpperCase()}
               </div>`;

          return `
            <div style="
              width:320px;height:128px;background:#fff;border:1px solid rgba(0,0,0,0.14);
              border-radius:16px;box-shadow:0 4px 14px rgba(0,0,0,0.08);
              padding:12px;display:flex;gap:12px;align-items:center;
            ">
              ${img}
              <div style="display:flex;flex-direction:column;gap:7px;min-width:0;flex:1;">

                <div style="
                  font-weight:900;font-size:16px;line-height:1.15;color:#111827;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${p.name}
                </div>

                ${p.team ? `
                  <div style="
                    font-size:12px;font-weight:800;color:#111827;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                  ">
                    ${p.team}
                  </div>
                ` : ""}

                ${p.location ? `
                  <div style="
                    font-size:12px;font-weight:700;color:#374151;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                  ">
                    ${p.location}
                  </div>
                ` : ""}

                ${p.email ? `
                  <div style="
                    font-size:11px;font-weight:700;color:#6B7280;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                  ">
                    ${p.email}
                  </div>
                ` : ""}

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

    // Reload from shared source
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

        <button onClick={() => chartObjRef.current?.fit()} style={{ padding: "8px 12px" }}>
          Fit
        </button>
        <button onClick={() => chartObjRef.current?.expandAll()} style={{ padding: "8px 12px" }}>
          Expand
        </button>
        <button
          onClick={() => chartObjRef.current?.collapseAll()}
          style={{ padding: "8px 12px" }}
        >
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
