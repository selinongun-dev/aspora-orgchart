"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import { useSearchParams } from "next/navigation";


type Row = {
  Name: string;
  "Work Email": string;
  "Manager Email": string;
  Team: string;
  Location: string;
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

function requiredColsMissing(headers: string[]) {
  const required = [
    "Name",
    "Work Email",
    "Manager Email",
    "Team",
    "Location",
    "Photo URL",
  ];
  const set = new Set(headers);
  return required.filter((c) => !set.has(c));
}

export default function Page() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartObjRef = useRef<any>(null);
  const searchParams = useSearchParams();
  const isEdit = searchParams.get("edit") === "1";


  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string>("");

  const nodes = useMemo(() => {
    // Build nodes using email IDs for hierarchy
    // id = Work Email, parentId = Manager Email
    const built = rows.map((r, i) => {
      const workEmail = String(r["Work Email"] || "").trim();
      const name = String(r.Name || "").trim();

      return {
        id: workEmail ? normalizeEmail(workEmail) : `name:${name.toLowerCase()}:${i}`,
        parentId: normalizeEmail(r["Manager Email"]) || null,
        name: name || workEmail || "(no name)",
        email: workEmail,
        team: (r.Team || "").trim(),
        location: (r.Location || "").trim(),
        photoUrl:
          ensureHttps(r["Photo URL"] || "") ||
          `https://ui-avatars.com/api/?background=eee&color=555&name=${encodeURIComponent(name || "User")}`,
      };
    });


    // If manager email doesn't exist in dataset, make parentId null (top-level)
    const ids = new Set(built.map((n) => n.id));
    return built.map((n) => ({
      ...n,
      parentId: n.parentId && ids.has(n.parentId) ? n.parentId : null,
    }));
  }, [rows]);

  function onUpload(file: File | null) {
    setError("");
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Please upload a .csv file (for now).");
      return;
    }

    Papa.parse<Row>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        try {
          const headers = (res.meta.fields || []) as string[];
          const missing = requiredColsMissing(headers);
          if (missing.length) {
            setError(`Missing required columns: ${missing.join(", ")}`);
            return;
          }

          // Required: Name (always)
          // Manager Email: allowed blank for root
          // Everything else optional (including Work Email)
          const data = (res.data || []).map((r: any, i: number) => {
            const row: Row = r as Row;

            const nameVal = String((row as any)["Name"] ?? "").trim();
            if (!nameVal) {
              throw new Error(`Row ${i + 2} has empty values for: Name`);
            }

            return row;
          });

          setError("");
          setRows(data);
        } catch (e: any) {
          setError(e?.message || String(e));
        }
      },
      error: (err) => setError(String(err)),
    });

    }

  useEffect(() => {
    if (!chartRef.current) return;
    const OrgChart = require("d3-org-chart").OrgChart;

    // Clear chart when no data
    if (!nodes.length) {
      chartRef.current.innerHTML = "";
      return;
    }

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
            error: (err) => setError(String(err)),
          });
        })
        .catch(() => {
          // first run: no CSV uploaded yet (normal)
        });
    }, []);

    chartRef.current.innerHTML = "";

    const chart = new OrgChart()
      .container(chartRef.current)
      .data(nodes)
      .nodeWidth(() => 320)
      .nodeHeight(() => 120)
      .childrenMargin(() => 50)
      .compactMarginBetween(() => 35)
      .compactMarginPair(() => 80)
      .nodeContent((d: any) => {
        const p = d.data;

        // Dedicated photo slot on the left
        const img = p.photoUrl
          ? `<img src="${p.photoUrl}" crossorigin="anonymous"
                 style="width:64px;height:64px;border-radius:16px;object-fit:cover;border:1px solid rgba(0,0,0,0.12)" />`
          : `<div style="width:64px;height:64px;border-radius:16px;background:rgba(0,0,0,0.06);
                 display:flex;align-items:center;justify-content:center;font-weight:700;">
               ${String(p.name).trim().slice(0, 1).toUpperCase()}
             </div>`;

        // “Info on top” – show Name + Title as primary lines
        return `
          <div style="
            width:320px;height:120px;background:#fff;border:1px solid rgba(0,0,0,0.12);
            border-radius:16px;box-shadow:0 2px 10px rgba(0,0,0,0.06);
            padding:12px;display:flex;gap:12px;align-items:center;
          ">
            ${img}
            <div style="display:flex;flex-direction:column;gap:4px;min-width:0;">
              <div style="font-weight:800;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${p.name}
              </div>
              <div style="font-size:12px;font-weight:600;">
                ${p.team}
              </div>
              <div style="font-size:11px;opacity:0.75;">
                ${p.location}
              </div>
              <div style="font-size:11px;opacity:0.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${p.email}
              </div>
            </div>
          </div>
        `;
      })
      .render();

    chartObjRef.current = chart;
  }, [nodes]);

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

              setError("");

              // Reload from shared source
              const csv = await (await fetch("/api/org")).text();
              Papa.parse<Row>(csv, {
                header: true,
                skipEmptyLines: true,
                complete: (r) => setRows((r.data || []) as Row[]),
                error: (err) => setError(String(err)),
              });
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
        <div style={{ color: "#b00020", fontWeight: 700, marginBottom: 12 }}>
          {error}
        </div>
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
        Headers required, values optional except Name.
      </div>
    </div>
  );
}
