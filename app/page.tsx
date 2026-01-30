"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";

type Row = {
  Name: string;
  "Work Email"?: string;
  "Manager Email"?: string;
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

function cleanHeader(h: string) {
  // trim + remove BOM (﻿) if present
  return (h || "").trim().replace(/^\uFEFF/, "");
}

function requiredColsMissing(headers: string[]) {
  const required = ["Name", "Work Email", "Manager Email", "Team", "Location", "Photo URL"];
  const set = new Set(headers.map(cleanHeader));
  return required.filter((c) => !set.has(c));
}

function parseCsvTextToRows(text: string): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    Papa.parse<Row>(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: cleanHeader,
      complete: (res) => {
        const headers = (res.meta.fields || []).map(cleanHeader);
        const missing = requiredColsMissing(headers);
        if (missing.length) {
          reject(new Error(`Missing required columns: ${missing.join(", ")}`));
          return;
        }

        const data = (res.data || []).filter(Boolean) as Row[];

        // basic sanity check
        const nonEmpty = data.filter((r) => String(r?.Name || "").trim());
        if (!nonEmpty.length) {
          reject(new Error("CSV parsed but no valid rows found (check Name column / file format)."));
          return;
        }

        resolve(nonEmpty);
      },
      error: (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))),
    });
  });
}

export default function ClientPage() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartObjRef = useRef<any>(null);

  const [isEdit, setIsEdit] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);

  // client-side only: read ?edit=1
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsEdit(params.get("edit") === "1");
  }, []);

  // Load shared CSV from server on first load (view-only users included)
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError("");

      try {
        const r = await fetch("/api/org", { cache: "no-store" });

        // If no file uploaded yet, your API might return 404/204 — treat as empty state, not crash.
        if (r.status === 404 || r.status === 204) {
          if (!cancelled) setRows([]);
          return;
        }

        if (!r.ok) {
          const t = await r.text().catch(() => "");
          throw new Error(t || `Failed to load /api/org (${r.status})`);
        }

        const text = await r.text();

        // If server accidentally returns JSON error, detect early
        if (!text.trim()) throw new Error("CSV is empty (server returned blank).");
        if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
          throw new Error(`Server returned JSON instead of CSV: ${text.slice(0, 120)}...`);
        }

        const data = await parseCsvTextToRows(text);
        if (!cancelled) setRows(data);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const nodes = useMemo(() => {
    const built = rows.map((r, i) => {
      const workEmail = String(r["Work Email"] || "").trim();
      const mgrEmail = String(r["Manager Email"] || "").trim();
      const name = String(r.Name || "").trim();

      return {
        id: workEmail ? normalizeEmail(workEmail) : `name:${name.toLowerCase()}:${i}`,
        parentId: mgrEmail ? normalizeEmail(mgrEmail) : null,
        name: name || workEmail || "(no name)",
        email: workEmail,
        team: String(r.Team || "").trim(),
        pod: String(r.Pod || "").trim(),
        location: String(r.Location || "").trim(),
        photoUrl:
          ensureHttps(String(r["Photo URL"] || "")) ||
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
          const p = d.data;

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

                <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
                  ${
                    p.team
                      ? `<span style="
                          font-size:12px;font-weight:850;color:#111827;
                          background:#F3F4F6;border:1px solid rgba(0,0,0,0.08);
                          padding:2px 8px;border-radius:999px;
                          white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;
                        ">${p.team}</span>`
                      : ""
                  }

                  ${
                    p.pod
                      ? `<span style="
                          font-size:12px;font-weight:850;color:#1E3A8A;
                          background:#EEF2FF;border:1px solid rgba(30,58,138,0.15);
                          padding:2px 8px;border-radius:999px;
                          white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;
                        ">${p.pod}</span>`
                      : ""
                  }
                </div>

                ${
                  p.location
                    ? `<div style="font-size:12px;font-weight:700;color:#374151;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        ${p.location}
                      </div>`
                    : ""
                }

                ${
                  p.email
                    ? `<div style="font-size:11px;font-weight:700;color:#6B7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        ${p.email}
                      </div>`
                    : ""
                }
              </div>
            </div>
          `;
        })
        .render();

      chartObjRef.current = chart;
      // nice default view
      chartObjRef.current?.fit?.();
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
    try {
      const r = await fetch("/api/org", { cache: "no-store" });
      if (!r.ok) throw new Error(await r.text());
      const csv = await r.text();
      const data = await parseCsvTextToRows(csv);
      setRows(data);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }

  return (
    <div style={{ padding: 20, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto" }}>
      <h1 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 16px 0" }}>
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
        <button onClick={() => chartObjRef.current?.collapseAll()} style={{ padding: "8px 12px" }}>
          Collapse
        </button>

        {loading ? <span style={{ marginLeft: 8, opacity: 0.7 }}>Loading…</span> : null}
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
        {!loading && !nodes.length && !error ? (
          <div style={{ padding: 16, opacity: 0.7 }}>
            No data yet. Upload a CSV (edit mode) or check that /api/org has a CSV stored.
          </div>
        ) : null}
      </div>

      <div style={{ marginTop: 10, opacity: 0.7, fontSize: 12 }}>
        CSV headers expected: Name, Work Email, Manager Email, Team, Location, Photo URL (optional: Pod)
      </div>
    </div>
  );
}