"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";

type LayoutMode = "hierarchy" | "pod";

type RawRow = Record<string, any>;

type PersonNode = {
  id: string;
  parentId: string | null;

  name: string;
  email: string;
  team: string;
  pod: string;
  location: string;
  photoUrl: string;

  // flags
  isPod?: false;
  isRoot?: boolean;
};

type PodNode = {
  id: string;
  parentId: string | null;

  name: string; // pod label
  pod: string;

  isPod: true;
  // pod altına bağlanan direct report person id’leri (click expand için yardımcı olabilir)
  _targets?: string[];
};

type NodeT = PersonNode | PodNode;

function normalizeEmail(v: string) {
  return (v || "").trim().toLowerCase();
}

function ensureHttps(url: string) {
  const u = (url || "").trim();
  if (!u) return "";
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  return `https://${u}`;
}

function safeKey(s: string) {
  return (s || "")
    .trim()
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "");
}

// CSV header alias helpers
const HEADER = {
  name: ["Name"],
  workEmail: ["Work Email", "WorkEmail", "Work_Email"],
  managerEmail: ["Manager Email", "ManagerEmail", "Manager_Email"],
  team: ["Team"],
  location: ["Location", "Country"],
  photoUrl: ["Photo URL", "PhotoURL", "Photo_Url", "Photo"],
  pod: ["Pod", "POD"],
};

function pick(row: RawRow, keys: string[]) {
  for (const k of keys) {
    const v = row?.[k];
    if (v !== undefined && v !== null) return String(v);
  }
  return "";
}

function requiredHeaderMissing(headers: string[]) {
  // Pod optional, Work Email header da optional (value da optional)
  const requiredGroups: Array<{ label: string; aliases: string[] }> = [
    { label: "Name", aliases: HEADER.name },
    { label: "Manager Email", aliases: HEADER.managerEmail },
    { label: "Team", aliases: HEADER.team },
    { label: "Location", aliases: HEADER.location },
    { label: "Photo URL", aliases: HEADER.photoUrl },
  ];

  const set = new Set(headers.map((h) => String(h).trim()));
  const missing: string[] = [];
  for (const g of requiredGroups) {
    if (!g.aliases.some((a) => set.has(a))) missing.push(g.label);
  }
  return missing;
}

// Pod normalizasyon (Founder's Office varyasyonlarını tekleştir)
function normalizePod(team: string, pod: string) {
  const t = (team || "").trim().replace(/[’‘]/g, "'");
  const p = (pod || "").trim().replace(/[’‘]/g, "'");

  const tl = t.toLowerCase();
  const pl = p.toLowerCase();

  // Founder's Office varyasyonları
  const isFO =
    tl === "founder's office" ||
    tl === "founders office" ||
    pl === "founder's office" ||
    pl === "founders office" ||
    pl === "fo";

  if (isFO) return "Founder's Office";

  // Pod boşsa team’i kullan (senin datanda pod her zaman dolu olmayabilir)
  return p || t || "";
}

// d3-org-chart sürümleri arasında değişebilen API’lere dayanıklı “subtree expand”
function expandSubtree(chart: any, startId: string) {
  // 1) Eğer getChartState varsa, internal data’yı alıp _expanded set edelim (en stabil yol)
  const st = chart?.getChartState?.();
  const data: any[] = st?.data;

  if (Array.isArray(data) && data.length) {
    const childrenBy = new Map<string, string[]>();
    for (const n of data) {
      const pid = n.parentId;
      if (!pid) continue;
      const arr = childrenBy.get(pid) || [];
      arr.push(n.id);
      childrenBy.set(pid, arr);
    }

    const stack = [startId];
    const seen = new Set<string>();

    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);

      const node = data.find((x) => x.id === id);
      if (node) node._expanded = true;

      const kids = childrenBy.get(id) || [];
      for (const k of kids) stack.push(k);
    }

    chart.data(data).render();
    return;
  }

  // 2) Fallback: sürüme göre expandAll varsa
  chart?.expandAll?.();
  chart?.render?.();
}

export default function ClientPage() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartObjRef = useRef<any>(null);

  const [isEdit, setIsEdit] = useState(false);
  const [layout, setLayout] = useState<LayoutMode>("hierarchy");

  const [rows, setRows] = useState<RawRow[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsEdit(params.get("edit") === "1");
  }, []);

  // load CSV from /api/org
  useEffect(() => {
    fetch("/api/org", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.text();
      })
      .then((text) => {
        Papa.parse<RawRow>(text, {
          header: true,
          skipEmptyLines: true,
          complete: (res) => {
            const headers = (res.meta.fields || []) as string[];
            const missing = requiredHeaderMissing(headers);
            if (missing.length) {
              setError(`CSV headers missing: ${missing.join(", ")}.`);
              setRows([]);
              return;
            }
            setError("");
            setRows((res.data || []) as RawRow[]);
          },
          error: (err) => setError(err instanceof Error ? err.message : String(err)),
        });
      })
      .catch(() => {
        // first run: no CSV is ok
      });
  }, []);

  // Build base people nodes (pure hierarchy)
  const basePeople = useMemo<PersonNode[]>(() => {
    const built: PersonNode[] = rows
      .map((r, i) => {
        const name = pick(r, HEADER.name).trim();
        const workEmail = pick(r, HEADER.workEmail).trim();
        const managerEmail = pick(r, HEADER.managerEmail).trim();
        const team = pick(r, HEADER.team).trim();
        const podRaw = pick(r, HEADER.pod).trim();
        const location = pick(r, HEADER.location).trim();
        const photo = ensureHttps(pick(r, HEADER.photoUrl).trim());

        if (!name) return null;

        const id = workEmail ? normalizeEmail(workEmail) : `name:${name.toLowerCase()}:${i}`;
        const parentId = managerEmail ? normalizeEmail(managerEmail) : null;

        const pod = normalizePod(team, podRaw);

        return {
          id,
          parentId,
          name,
          email: workEmail,
          team,
          pod,
          location,
          photoUrl:
            photo ||
            `https://ui-avatars.com/api/?background=eee&color=555&name=${encodeURIComponent(
              name || "User"
            )}`,
        } as PersonNode;
      })
      .filter(Boolean) as PersonNode[];

    // If manager not found => root
    const ids = new Set(built.map((n) => n.id));
    const fixed = built.map((n) => ({
      ...n,
      parentId: n.parentId && ids.has(n.parentId) ? n.parentId : null,
    }));

    // Multiple roots varsa synthetic root üret (chart daha düzgün)
    const roots = fixed.filter((n) => n.parentId === null);
    if (roots.length <= 1) {
      return fixed;
    }

    const syntheticRoot: PersonNode = {
      id: "root:company",
      parentId: null,
      name: "Aspora",
      email: "",
      team: "",
      pod: "",
      location: "",
      photoUrl: `https://ui-avatars.com/api/?background=eee&color=555&name=${encodeURIComponent(
        "Aspora"
      )}`,
      isRoot: true,
    };

    return [
      syntheticRoot,
      ...fixed.map((n) => (n.parentId === null ? { ...n, parentId: syntheticRoot.id } : n)),
    ];
  }, [rows]);

  // POD VIEW: only one pod layer under top root (no repeated pods)
  const podViewNodes = useMemo<NodeT[]>(() => {
    if (!basePeople.length) return [];

    const all = basePeople.map((n) => ({ ...n })) as PersonNode[];

    // find root (single root now, thanks to synthetic root)
    const root = all.find((n) => n.parentId === null);
    if (!root) return all;

    // children map
    const childrenBy = new Map<string, PersonNode[]>();
    for (const p of all) {
      if (!p.parentId) continue;
      const arr = childrenBy.get(p.parentId) || [];
      arr.push(p);
      childrenBy.set(p.parentId, arr);
    }

    const direct = (childrenBy.get(root.id) || []).slice();

    // group direct reports by pod
    const groups = new Map<string, PersonNode[]>();
    for (const dr of direct) {
      const key = (dr.pod || dr.team || "Other").trim() || "Other";
      const arr = groups.get(key) || [];
      arr.push(dr);
      groups.set(key, arr);
    }

    // create pod nodes
    const podNodes: PodNode[] = [];
    const podIdByKey = new Map<string, string>();

    for (const [podKey, members] of groups.entries()) {
      const podId = `pod:${safeKey(podKey) || "other"}`;
      podIdByKey.set(podKey, podId);

      podNodes.push({
        id: podId,
        parentId: root.id,
        name: podKey,
        pod: podKey,
        isPod: true,
        _targets: members.map((m) => m.id),
      });
    }

    // reparent ONLY direct reports under pod node
    const updatedPeople = all.map((p) => {
      if (p.parentId === root.id) {
        const key = (p.pod || p.team || "Other").trim() || "Other";
        const podId = podIdByKey.get(key)!;
        return { ...p, parentId: podId };
      }
      return p;
    });

    // return root + pod nodes + rest
    return [root, ...podNodes, ...updatedPeople.filter((n) => n.id !== root.id)];
  }, [basePeople]);

  const nodesToRender: NodeT[] = layout === "pod" ? podViewNodes : (basePeople as any);

  // render chart
  useEffect(() => {
    if (!chartRef.current) return;

    if (!nodesToRender.length) {
      chartRef.current.innerHTML = "";
      return;
    }

    chartRef.current.innerHTML = "";
    let cancelled = false;

    (async () => {
      const mod: any = await import("d3-org-chart");
      const OrgChart = mod.OrgChart;

      if (cancelled || !chartRef.current) return;

      const LILAC = "#5B2EFF";
      const LILAC_BG = "#F3F0FF";

      const chart = new OrgChart()
        .container(chartRef.current)
        .data(nodesToRender as any)
        .nodeWidth((d: any) => (d.data?.isPod ? 340 : 340))
        .nodeHeight((d: any) => (d.data?.isPod ? 86 : 132))
        .childrenMargin(() => 52)
        .compactMarginBetween(() => 34)
        .compactMarginPair(() => 80)
        .onNodeClick((d: any) => {
          // Pod view: pod node click => expand full subtree at once
          if (layout === "pod" && d?.data?.isPod) {
            expandSubtree(chart, d.data.id);
            chart.fit?.();
            return;
          }
          // Person nodes default toggle behavior (library handles)
        })
        .nodeContent((d: any) => {
          const p: NodeT = d.data;

          // POD NODE (NO "x people" text)
          if ((p as any).isPod) {
            return `
              <div style="
                width:340px;height:86px;background:${LILAC_BG};
                border:1px solid rgba(0,0,0,0.10);
                border-radius:18px;box-shadow:0 6px 18px rgba(0,0,0,0.06);
                display:flex;align-items:center;justify-content:center;
                position:relative; overflow:hidden;
              ">
                <div style="position:absolute;left:0;top:0;bottom:0;width:6px;background:${LILAC};"></div>
                <div style="
                  font-weight:950;font-size:18px;color:#111827;
                  padding:0 16px;text-align:center;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:320px;
                ">
                  ${p.name}
                </div>
              </div>
            `;
          }

          // PERSON NODE (4 lines + pod label on top line)
          const person = p as PersonNode;

          const img = person.photoUrl
            ? `<img src="${person.photoUrl}" crossorigin="anonymous"
                 style="width:64px;height:64px;border-radius:16px;object-fit:cover;border:1px solid rgba(0,0,0,0.12)" />`
            : `<div style="width:64px;height:64px;border-radius:16px;background:rgba(0,0,0,0.06);
                 display:flex;align-items:center;justify-content:center;font-weight:900;">
                 ${String(person.name).trim().slice(0, 1).toUpperCase()}
               </div>`;

          // Pod label: name ile çakışmasın diye ÜST SATIRDA, absolute değil
          const podLine =
            person.pod && layout !== "pod"
              ? `
                <div style="
                  display:flex;
                  margin-bottom:2px;
                ">
                  <span style="
                    font-size:11px;font-weight:900;color:${LILAC};
                    background:#EEE9FF;border:1px solid rgba(91,46,255,0.18);
                    padding:2px 8px;border-radius:999px;
                    max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                  ">${person.pod}</span>
                </div>
              `
              : "";

          return `
            <div style="
              width:340px;height:132px;background:#fff;
              border:1px solid rgba(0,0,0,0.12);
              border-radius:18px;box-shadow:0 6px 18px rgba(0,0,0,0.06);
              padding:12px;display:flex;gap:12px;align-items:center;
              position:relative; overflow:hidden;
            ">
              <div style="position:absolute;left:0;top:0;bottom:0;width:6px;background:${LILAC};"></div>

              ${img}

              <div style="display:flex;flex-direction:column;gap:6px;min-width:0;flex:1;">
                ${podLine}

                <div style="
                  font-weight:950;font-size:16px;line-height:1.1;color:#111827;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${person.name}
                </div>

                <div style="
                  font-size:13px;font-weight:850;color:#111827;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${person.team || ""}
                </div>

                <div style="
                  font-size:12px;font-weight:750;color:#374151;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${person.location || ""}
                </div>

                <div style="
                  font-size:12px;font-weight:750;color:#6B7280;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${person.email || ""}
                </div>
              </div>
            </div>
          `;
        })
        .render();

      chartObjRef.current = chart;

      // Pod view: başlangıçta pod başlıklarını gör; pod’a tıkla => full subtree açılacak
      if (layout === "pod") {
        // collapse all, sonra root’u açık bırak
        chart.collapseAll?.();

        // root’u expanded yap (varsa getChartState üzerinden)
        const st = chart.getChartState?.();
        const data: any[] = st?.data;
        if (Array.isArray(data) && data.length) {
          const root = data.find((x) => x.parentId === null);
          if (root) root._expanded = true;
          chart.data(data).render();
        }

        chart.fit?.();
      } else {
        chart.fit?.();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [nodesToRender, layout]);

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
    const csv = await (await fetch("/api/org", { cache: "no-store" })).text();
    Papa.parse<RawRow>(csv, {
      header: true,
      skipEmptyLines: true,
      complete: (r) => setRows((r.data || []) as RawRow[]),
      error: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    });
  }

  return (
    <div style={{ padding: 20, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto" }}>
      <h1 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 14px 0" }}>
        Aspora Organisational Chart
      </h1>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
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

        <button
          onClick={() => setLayout("hierarchy")}
          style={{
            padding: "8px 12px",
            fontWeight: 800,
            borderRadius: 10,
            border: layout === "hierarchy" ? "2px solid #5B2EFF" : "1px solid rgba(0,0,0,0.15)",
            background: layout === "hierarchy" ? "#F3F0FF" : "white",
          }}
        >
          Hierarchy view
        </button>

        <button
          onClick={() => setLayout("pod")}
          style={{
            padding: "8px 12px",
            fontWeight: 800,
            borderRadius: 10,
            border: layout === "pod" ? "2px solid #5B2EFF" : "1px solid rgba(0,0,0,0.15)",
            background: layout === "pod" ? "#F3F0FF" : "white",
          }}
        >
          Pod view
        </button>

        <div style={{ width: 12 }} />

        <button onClick={() => chartObjRef.current?.fit?.()} style={{ padding: "8px 12px" }}>
          Fit
        </button>
        <button onClick={() => chartObjRef.current?.expandAll?.()} style={{ padding: "8px 12px" }}>
          Expand
        </button>
        <button onClick={() => chartObjRef.current?.collapseAll?.()} style={{ padding: "8px 12px" }}>
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
        Accepted headers: Name, Manager Email, Team, Location, Photo URL (aliases supported). Pod optional.
      </div>
    </div>
  );
}

