"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";

type Row = {
  Name: string;
  "Work Email": string;
  "Manager Email": string;
  Team: string;
  Pod?: string;
  Location: string; // country burada
  "Photo URL": string;
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

/** Pod tekilleştirme (FO / Founder’s Office vs.) */
function normalizePod(podRaw: string) {
  const p = (podRaw || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[’‘]/g, "'"); // apostrophe normalize

  if (!p) return "";

  const key = p.toLowerCase();

  // burada mapping’i istediğin gibi büyütebilirsin
  const map: Record<string, string> = {
    "fo": "Founder's Office",
    "founders office": "Founder's Office",
    "founder's office": "Founder's Office",
    "founder’s office": "Founder's Office",
    "cx": "CX",
    "qa eng.": "QA Eng.",
  };

  return map[key] ?? p;
}

/** Pod’a göre renk (deterministic) */
function hashToIndex(s: string, mod: number) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return mod ? h % mod : 0;
}

const POD_COLORS = [
  { border: "#2563EB", bg: "#EFF6FF" }, // blue
  { border: "#7C3AED", bg: "#F5F3FF" }, // purple
  { border: "#059669", bg: "#ECFDF5" }, // green
  { border: "#DC2626", bg: "#FEF2F2" }, // red
  { border: "#EA580C", bg: "#FFF7ED" }, // orange
  { border: "#0F766E", bg: "#F0FDFA" }, // teal
  { border: "#4F46E5", bg: "#EEF2FF" }, // indigo
  { border: "#B45309", bg: "#FFFBEB" }, // amber
  { border: "#BE185D", bg: "#FDF2F8" }, // pink
  { border: "#374151", bg: "#F9FAFB" }, // gray
];

export default function ClientPage() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartObjRef = useRef<any>(null);

  const [isEdit, setIsEdit] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string>("");

  // edit mode only by ?edit=1
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsEdit(params.get("edit") === "1");
  }, []);

  // Load shared CSV
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
        // first run: no CSV yet
      });
  }, []);

  const nodes = useMemo(() => {
    const built = rows.map((r, i) => {
      const workEmail = String(r["Work Email"] || "").trim();
      const name = String(r.Name || "").trim();

      const pod = normalizePod(String(r.Pod || ""));
      const podColor =
        pod ? POD_COLORS[hashToIndex(pod, POD_COLORS.length)] : null;

      return {
        id: workEmail ? normalizeEmail(workEmail) : `name:${name.toLowerCase()}:${i}`,
        parentId: normalizeEmail(r["Manager Email"]) || null,

        name: name || workEmail || "(no name)",
        email: workEmail,
        team: String(r.Team || "").trim(),
        pod,
        podBorder: podColor?.border || "#E5E7EB",
        podBg: podColor?.bg || "#FFFFFF",
        location: String(r.Location || "").trim(),
        photoUrl:
          ensureHttps(r["Photo URL"] || "") ||
          `https://ui-avatars.com/api/?background=eee&color=555&name=${encodeURIComponent(
            name || "User"
          )}`,
      };
    });

    // if manager not in set, make root
    const ids = new Set(built.map((n) => n.id));
    return built.map((n) => ({
      ...n,
      parentId: n.parentId && ids.has(n.parentId) ? n.parentId : null,
    }));
  }, [rows]);

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
        .nodeWidth(() => 340)
        .nodeHeight(() => 120)
        .childrenMargin(() => 55)
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

          // ONLY: Name / Team / Country(Location) / Email
          // Pod: small badge (does not replace team)
          return `
            <div style="
              width:340px;height:120px;
              background:${p.podBg};
              border:1px solid rgba(0,0,0,0.12);
              border-left:8px solid ${p.podBorder};
              border-radius:16px;
              box-shadow:0 4px 14px rgba(0,0,0,0.08);
              padding:12px;
              display:flex;gap:12px;align-items:center;
            ">
              ${img}

              <div style="display:flex;flex-direction:column;gap:6px;min-width:0;flex:1;">
                <div style="
                  display:flex;align-items:center;justify-content:space-between;gap:8px;
                  min-width:0;
                ">
                  <div style="
                    font-weight:900;font-size:16px;line-height:1.15;color:#111827;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                    min-width:0;
                  ">
                    ${p.name}
                  </div>

                  ${
                    p.pod
                      ? `<span style="
                          font-size:11px;font-weight:900;color:${p.podBorder};
                          background:#FFFFFFCC;
                          border:1px solid ${p.podBorder}33;
                          padding:2px 8px;border-radius:999px;
                          white-space:nowrap;
                        ">${p.pod}</span>`
                      : ""
                  }
                </div>

                <div style="
                  font-size:13px;font-weight:800;color:#111827;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${p.team || ""}
                </div>

                <div style="
                  font-size:12px;font-weight:800;color:#374151;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${p.location || ""}
                </div>

                <div style="
                  font-size:12px;font-weight:800;color:#6B7280;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${p.email || ""}
                </div>
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
