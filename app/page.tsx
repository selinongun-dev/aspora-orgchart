"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";

type Row = {
  Name: string;
  "Work Email": string;
  "Manager Email": string;
  Team?: string;
  Pod?: string; // optional
  Location?: string; // country
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

// Pod başına tutarlı renk üretmek için basit hash -> HSL
function podColor(pod: string) {
  const s = (pod || "").trim();
  if (!s) return { bg: "rgba(0,0,0,0)", border: "rgba(0,0,0,0)" };
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return {
    bg: `hsla(${h}, 70%, 95%, 1)`,
    border: `hsla(${h}, 65%, 45%, 1)`,
  };
}

function requiredColsMissing(headers: string[]) {
  // Pod opsiyonel, ama header varsa okuyalım.
  // Temel beklediğimiz kolonlar:
  const required = ["Name", "Work Email", "Manager Email", "Team", "Location", "Photo URL"];
  const set = new Set(headers);
  return required.filter((c) => !set.has(c));
}

export default function ClientPage() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartObjRef = useRef<any>(null);

  const [isEdit, setIsEdit] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string>("");

  // edit mode sadece client-side query’den okunur
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsEdit(params.get("edit") === "1");
  }, []);

  // View-only dahil: server'daki CSV'yi çek
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
        // ilk kurulumda CSV yoksa normal
      });
  }, []);

  const nodes = useMemo(() => {
    // KİŞİLER DIŞINDA HİÇBİR NODE YOK.
    // Sadece person nodes -> hierarchy = manager email
    const built = rows.map((r, i) => {
      const name = String(r.Name || "").trim();
      const workEmail = String(r["Work Email"] || "").trim();
      const mgrEmail = String(r["Manager Email"] || "").trim();

      const id = workEmail
        ? normalizeEmail(workEmail)
        : `name:${name.toLowerCase()}:${i}`;

      return {
        id,
        parentId: mgrEmail ? normalizeEmail(mgrEmail) : null,
        name: name || "(no name)",
        email: workEmail,
        team: String(r.Team || "").trim(),
        pod: String(r.Pod || "").trim(),
        location: String(r.Location || "").trim(),
        photoUrl:
          ensureHttps(r["Photo URL"] || "") ||
          `https://ui-avatars.com/api/?background=eee&color=555&name=${encodeURIComponent(
            name || "User"
          )}`,
      };
    });

    // parent dataset'te yoksa root yap
    const ids = new Set(built.map((n) => n.id));
    let cleaned = built.map((n) => ({
      ...n,
      parentId: n.parentId && ids.has(n.parentId) ? n.parentId : null,
    }));

    // Pod'a göre "aynı manager altındaki" kişileri yan yana getirmek için:
    // d3-org-chart child sırasını data order'dan etkilenerek oluşturuyor (genelde).
    // parentId -> pod -> name sıralaması iyi kümeler.
    cleaned = cleaned.sort((a, b) => {
      const pa = a.parentId || "";
      const pb = b.parentId || "";
      if (pa !== pb) return pa.localeCompare(pb);
      const poda = (a.pod || "").toLowerCase();
      const podb = (b.pod || "").toLowerCase();
      if (poda !== podb) return poda.localeCompare(podb);
      return (a.name || "").localeCompare(b.name || "");
    });

    return cleaned;
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
        .nodeWidth(() => 320)
        .nodeHeight(() => 120)
        .childrenMargin(() => 50)
        .compactMarginBetween(() => 35)
        .compactMarginPair(() => 80)
        .nodeContent((d: any) => {
          const p = d.data;
          const c = podColor(p.pod);

          const img = p.photoUrl
            ? `<img src="${p.photoUrl}" crossorigin="anonymous"
                 style="width:64px;height:64px;border-radius:16px;object-fit:cover;border:1px solid rgba(0,0,0,0.12)" />`
            : `<div style="width:64px;height:64px;border-radius:16px;background:rgba(0,0,0,0.06);
                 display:flex;align-items:center;justify-content:center;font-weight:800;">
               ${String(p.name).trim().slice(0, 1).toUpperCase()}
             </div>`;

          // İSTEDİĞİN 4 satır: Name / Team / Country(Location) / Email
          // Pod: ayrı satır yapmıyoruz; sadece görsel label + sol border olarak "gruplama hissi"
          return `
            <div style="
              width:320px;height:120px;
              background:${c.bg};
              border:1px solid rgba(0,0,0,0.14);
              border-left:6px solid ${c.border};
              border-radius:16px;
              box-shadow:0 4px 14px rgba(0,0,0,0.08);
              padding:12px;
              display:flex;gap:12px;align-items:center;
              position:relative;
            ">
              ${
                p.pod
                  ? `<div style="
                      position:absolute;top:10px;right:12px;
                      font-size:11px;font-weight:800;color:#111827;
                      background:rgba(255,255,255,0.75);
                      border:1px solid rgba(0,0,0,0.08);
                      padding:2px 8px;border-radius:999px;
                      max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                    ">${p.pod}</div>`
                  : ``
              }
              ${img}
              <div style="display:flex;flex-direction:column;gap:6px;min-width:0;flex:1;">
                <div style="
                  font-weight:900;font-size:16px;line-height:1.15;color:#111827;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">${p.name}</div>

                <div style="
                  font-size:13px;font-weight:800;color:#111827;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">${p.team || ""}</div>

                <div style="
                  font-size:12px;font-weight:700;color:#374151;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">${p.location || ""}</div>

                <div style="
                  font-size:11px;font-weight:700;color:#6B7280;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">${p.email || ""}</div>
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

    // Reload
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
        CSV headers: Name, Work Email, Manager Email, Team, Location, Photo URL (optional: Pod).
        Pod is used for visual grouping + sorting; hierarchy stays Manager Email.
      </div>
    </div>
  );
}
