"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";

type RawRow = Record<string, any>;

type Row = {
  Name: string;
  "Work Email": string;
  "Manager Email": string;
  Team: string;
  Location: string;
  "Photo URL": string;
  Pod?: string;
};

type NodeData = {
  id: string;
  parentId: string | null;
  name: string;
  email: string;
  team: string;
  location: string;
  photoUrl: string;
  pod?: string;

  // flags
  isPod?: boolean;
  podKey?: string;

  // expansion
  _expanded?: boolean;
};

const LILAC = "#6D28D9";
const LILAC_BG = "#F5F3FF";
const BORDER = "rgba(17,24,39,0.14)"; // slate-ish

function normalizeEmail(v: string) {
  return (v || "").trim().toLowerCase();
}

function normalizeText(v: string) {
  return String(v ?? "").trim();
}

function ensureHttps(url: string) {
  const u = (url || "").trim();
  if (!u) return "";
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  return `https://${u}`;
}

/**
 * Header aliases:
 * Your CSV now can contain e.g. Job Title / Manager Name etc.
 * We only map what we need, with flexible column names.
 */
function toRow(r: RawRow): Row {
  const get = (...keys: string[]) => {
    for (const k of keys) {
      if (r[k] !== undefined && r[k] !== null && String(r[k]).trim() !== "") return r[k];
    }
    return "";
  };

  return {
    Name: normalizeText(get("Name", "Full Name")),
    "Work Email": normalizeText(get("Work Email", "Email", "Work email", "WorkEmail")),
    "Manager Email": normalizeText(get("Manager Email", "ManagerEmail", "Manager E-mail")),
    Team: normalizeText(get("Team", "Department", "Function")),
    Location: normalizeText(get("Location", "Country", "Office", "Region")),
    "Photo URL": normalizeText(get("Photo URL", "Photo", "PhotoURL", "Photo Url")),
    Pod: normalizeText(get("Pod", "POD", "Squad", "Tribe")),
  };
}

function requiredColsMissing(headers: string[]) {
  // We require at least these columns (Pod optional)
  const required = ["Name", "Work Email", "Manager Email", "Team", "Location", "Photo URL"];
  const set = new Set(headers);
  // allow aliases by accepting any header set that includes at least one of the key variants:
  // We'll enforce after parsing by checking Row fields too.
  return required.filter((c) => !set.has(c));
}

type LayoutMode = "hierarchy" | "pods";

export default function ClientPage() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartObjRef = useRef<any>(null);

  const [isEdit, setIsEdit] = useState(false);
  const [layout, setLayout] = useState<LayoutMode>("hierarchy");

  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string>("");

  // which pods are expanded in pod mode
  const [expandedPods, setExpandedPods] = useState<Record<string, boolean>>({});

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
        Papa.parse<RawRow>(text, {
          header: true,
          skipEmptyLines: true,
          complete: (res) => {
            const raw = (res.data || []) as RawRow[];
            const mapped = raw.map(toRow);

            // basic sanity: Name required
            const cleaned = mapped.filter((x) => x.Name.trim() !== "");
            setRows(cleaned);
          },
          error: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
        });
      })
      .catch(() => {
        // first run normal
      });
  }, []);

  // Build base "people nodes" once
  const peopleNodes: NodeData[] = useMemo(() => {
    const built = rows.map((r, i) => {
      const email = normalizeEmail(r["Work Email"]);
      const name = normalizeText(r.Name);

      const id = email || `name:${name.toLowerCase()}:${i}`;

      const photo =
        ensureHttps(r["Photo URL"] || "") ||
        `https://ui-avatars.com/api/?background=eee&color=555&name=${encodeURIComponent(
          name || "User"
        )}`;

      return {
        id,
        parentId: normalizeEmail(r["Manager Email"]) || null,
        name: name || email || "(no name)",
        email: normalizeText(r["Work Email"]),
        team: normalizeText(r.Team),
        location: normalizeText(r.Location),
        photoUrl: photo,
        pod: normalizeText(r.Pod || "") || undefined,
      };
    });

    // Fix parentId if manager missing from dataset (becomes root)
    const ids = new Set(built.map((n) => n.id));
    return built.map((n) => ({
      ...n,
      parentId: n.parentId && ids.has(n.parentId) ? n.parentId : null,
    }));
  }, [rows]);

  // find root (CEO): the first node with parentId null
  const rootId = useMemo(() => {
    const r = peopleNodes.find((n) => n.parentId === null);
    return r?.id || (peopleNodes[0]?.id ?? null);
  }, [peopleNodes]);

  /**
   * POD MODE GRAPH:
   * - Create virtual nodes: pod:<podKey>
   * - CEO children become all pods (not "No Pod")
   * - Inside each pod:
   *    - keep manager->report relations ONLY if manager is in same pod
   *    - otherwise attach person to pod node
   * - Clicking pod should expand all inside that pod (we drive via expandedPods + _expanded flags)
   */
  const nodes: NodeData[] = useMemo(() => {
    if (!peopleNodes.length) return [];

    if (layout === "hierarchy") {
      // plain hierarchy
      return peopleNodes.map((n) => ({ ...n }));
    }

    // pods layout
    const root = rootId;
    if (!root) return peopleNodes.map((n) => ({ ...n }));

    const byId = new Map<string, NodeData>();
    for (const n of peopleNodes) byId.set(n.id, n);

    // gather pods (exclude empty)
    const pods = Array.from(
      new Set(
        peopleNodes
          .map((n) => normalizeText(n.pod || ""))
          .map((x) => x.trim())
          .filter((x) => x.length > 0)
      )
    ).sort((a, b) => a.localeCompare(b));

    // virtual pod nodes
    const podNodes: NodeData[] = pods.map((p) => {
      const key = p; // already a label
      return {
        id: `pod:${key.toLowerCase()}`,
        parentId: root, // all pods under CEO
        name: key,
        email: "",
        team: "",
        location: "",
        photoUrl: "",
        isPod: true,
        podKey: key,
        _expanded: !!expandedPods[key],
      };
    });

    const podIdByKey = new Map<string, string>();
    for (const pn of podNodes) podIdByKey.set(pn.podKey!, pn.id);

    // Assign people under pods
    const peopleInPod: NodeData[] = peopleNodes.map((n) => {
      const podKey = (n.pod || "").trim();
      if (!podKey) {
        // No pod: keep in original hierarchy (CEO etc.)
        return { ...n };
      }

      const managerId = n.parentId;
      const manager = managerId ? byId.get(managerId) : null;
      const samePodManager = manager && (manager.pod || "").trim() === podKey;

      // If manager is same pod, keep original parentId
      // Else attach to pod node
      const parentId = samePodManager ? managerId : podIdByKey.get(podKey)!;

      // expansion rule: if pod is expanded, expand everything under it
      const expanded = !!expandedPods[podKey];

      return {
        ...n,
        parentId,
        _expanded: expanded ? true : undefined,
      };
    });

    // Important: CEO should remain the root visible node.
    // If CEO has a Pod in CSV, we still keep CEO as root (not inside pod).
    // So force root node to have parentId null.
    const final = [...podNodes, ...peopleInPod].map((n) =>
      n.id === root ? { ...n, parentId: null } : n
    );

    return final;
  }, [peopleNodes, layout, expandedPods, rootId]);

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
        .nodeWidth((d: any) => (d.data?.isPod ? 360 : 520))
        // Make node taller so the expand button sits UNDER the card, not on top of text
        .nodeHeight((d: any) => (d.data?.isPod ? 120 : 190))
        .childrenMargin(() => 60)
        .compactMarginBetween(() => 40)
        .compactMarginPair(() => 90)

        // Show TOTAL descendants count (not just direct children)
        .buttonContent((d: any) => {
          const data: NodeData = d.data;

          // total descendants excluding self
          const totalDesc = (d.descendants?.()?.length ?? 1) - 1;

          // For pod node, show pod total people count (descendants excluding pod node)
          const label = data.isPod ? String(totalDesc) : String(totalDesc);

          // If no children at all, hide content
          if (totalDesc <= 0) return `<div style="display:none"></div>`;

          return `
            <div style="
              width:34px;height:22px;
              border-radius:999px;
              background:white;
              border:1px solid rgba(17,24,39,0.18);
              box-shadow:0 6px 16px rgba(0,0,0,0.08);
              display:flex;align-items:center;justify-content:center;
              font-size:12px;font-weight:900;color:#111827;
            ">
              ${label}
            </div>
          `;
        })

        // Clicking behavior:
        // - Pod mode: clicking pod header toggles expand for entire pod
        // - Normal mode: default expand/collapse node
        .onNodeClick((d: any) => {
          const data: NodeData = d.data;
          if (data.isPod && data.podKey) {
            setExpandedPods((prev) => ({ ...prev, [data.podKey!]: !prev[data.podKey!] }));
            return;
          }
        })

        .nodeContent((d: any) => {
          const p: NodeData = d.data;

          // POD HEADER CARD
          if (p.isPod) {
            return `
              <div style="
                width:360px;height:90px;
                background:${LILAC_BG};
                border:1px solid ${BORDER};
                border-radius:18px;
                box-shadow:0 10px 22px rgba(0,0,0,0.06);
                display:flex;align-items:center;justify-content:center;
                position:relative; overflow:hidden;
              ">
                <div style="position:absolute;left:0;top:0;bottom:0;width:7px;background:${LILAC};"></div>
                <div style="
                  font-weight:950;
                  font-size:20px;
                  color:#111827;
                  padding:0 18px;
                  text-align:center;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                  max-width:330px;
                ">
                  ${p.name}
                </div>
              </div>
            `;
          }

          // PERSON CARD
          const img = p.photoUrl
            ? `<img src="${p.photoUrl}" crossorigin="anonymous"
                 style="width:76px;height:76px;border-radius:18px;object-fit:cover;border:1px solid rgba(0,0,0,0.12)" />`
            : `<div style="width:76px;height:76px;border-radius:18px;background:rgba(0,0,0,0.06);
                 display:flex;align-items:center;justify-content:center;font-weight:900;font-size:22px;">
                 ${(p.name || "?").trim().slice(0, 1).toUpperCase()}
               </div>`;

          // team, location, email only (4 lines as you want)
          return `
            <div style="
              width:520px;height:130px;
              background:#fff;
              border:1px solid ${BORDER};
              border-radius:22px;
              box-shadow:0 12px 26px rgba(0,0,0,0.06);
              padding:16px 16px;
              display:flex;gap:14px;align-items:center;
              position:relative; overflow:hidden;
            ">
              <div style="position:absolute;left:0;top:0;bottom:0;width:7px;background:${LILAC};"></div>

              ${img}

              <div style="display:flex;flex-direction:column;gap:6px;min-width:0;flex:1;">
                <div style="
                  font-weight:950;font-size:22px;line-height:1.1;color:#111827;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${p.name}
                </div>

                <div style="
                  font-size:16px;font-weight:850;color:#111827;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${p.team || ""}
                </div>

                <div style="
                  font-size:15px;font-weight:800;color:#374151;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${p.location || ""}
                </div>

                <div style="
                  font-size:14px;font-weight:800;color:#6B7280;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${p.email || ""}
                </div>
              </div>

              ${
                p.pod
                  ? `
                <div style="
                  position:absolute; top:10px; right:12px;
                  font-size:13px; font-weight:950;
                  color:${LILAC};
                  background:${LILAC_BG};
                  border:1px solid rgba(109,40,217,0.20);
                  padding:6px 12px;
                  border-radius:999px;
                  max-width:220px;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${p.pod}
                </div>`
                  : ""
              }
            </div>
          `;
        })

        .render();

      chartObjRef.current = chart;
      chart.fit();
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
    Papa.parse<RawRow>(csv, {
      header: true,
      skipEmptyLines: true,
      complete: (r) => {
        const mapped = ((r.data || []) as RawRow[]).map(toRow);
        setRows(mapped.filter((x) => x.Name.trim() !== ""));
      },
      error: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    });
  }

  return (
    <div style={{ padding: 20, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto" }}>
      <h1 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 14px 0" }}>
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
              // reset input so choosing the same file again works
              e.currentTarget.value = "";
            }}
          />
        )}

        <button
          onClick={() => setLayout("hierarchy")}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid rgba(0,0,0,0.12)",
            background: layout === "hierarchy" ? LILAC_BG : "white",
            fontWeight: 900,
          }}
        >
          Hierarchy
        </button>

        <button
          onClick={() => setLayout("pods")}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid rgba(0,0,0,0.12)",
            background: layout === "pods" ? LILAC_BG : "white",
            fontWeight: 900,
          }}
        >
          Pods
        </button>

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
        CSV headers expected: Name, Work Email, Manager Email, Team, Location, Photo URL (optional: Pod).
      </div>
    </div>
  );
}
