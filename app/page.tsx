"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";

type RawRow = Record<string, unknown>;

type Person = {
  name: string;
  workEmail: string;
  managerEmail: string;
  team: string;
  location: string;
  photoUrl: string;
  pod: string;
};

type NodeT = {
  id: string;
  parentId: string | null;
  // common
  name: string;
  // person fields
  email?: string;
  team?: string;
  location?: string;
  photoUrl?: string;
  pod?: string;

  // pod node fields
  isPod?: boolean;
  podKey?: string;
  podCount?: number;
};

const LILAC = "#6D28D9";
const LILAC_BG = "#F5F3FF";

function normalizeEmail(v: string) {
  return (v || "").trim().toLowerCase();
}

function ensureHttps(url: string) {
  const u = (url || "").trim();
  if (!u) return "";
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  return `https://${u}`;
}

function getStr(row: RawRow, keys: string[]) {
  for (const k of keys) {
    const v = row[k];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}

function missingRequired(headers: string[]) {
  // allow aliases; we validate minimally (Name + Work Email is strongly preferred, but Work Email can be empty)
  const required = ["Name", "Manager Email", "Team", "Location", "Photo URL"];
  const set = new Set(headers);
  return required.filter((c) => !set.has(c));
}

export default function Page() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartObjRef = useRef<any>(null);

  const [isEdit, setIsEdit] = useState(false);
  const [view, setView] = useState<"hierarchy" | "pod">("hierarchy");

  const [rows, setRows] = useState<Person[]>([]);
  const [error, setError] = useState("");

  // edit mode param
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsEdit(params.get("edit") === "1");
  }, []);

  // load CSV from server
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
            const data = (res.data || []) as RawRow[];
            const mapped: Person[] = data.map((r) => {
              const name = getStr(r, ["Name"]);
              const workEmail = getStr(r, ["Work Email", "WorkEmail", "Email", "Work email"]);
              const managerEmail = getStr(r, ["Manager Email", "ManagerEmail", "Manager email"]);
              const team = getStr(r, ["Team"]);
              const location = getStr(r, ["Location", "Country"]);
              const photo = getStr(r, ["Photo URL", "Photo", "PhotoURL"]);
              const pod = getStr(r, ["Pod", "POD", "pod"]); // <-- IMPORTANT: Pod kolonu buradan

              return {
                name,
                workEmail,
                managerEmail,
                team,
                location,
                photoUrl: ensureHttps(photo),
                pod,
              };
            });

            // basic validation: Name required
            for (let i = 0; i < mapped.length; i++) {
              if (!mapped[i].name) {
                setError(`Row ${i + 2} has empty Name`);
                return;
              }
            }

            setError("");
            setRows(mapped);
          },
          error: (err: unknown) =>
            setError(err instanceof Error ? err.message : String(err)),
        });
      })
      .catch(() => {
        // no csv yet
      });
  }, []);

  // build hierarchy nodes (plain people)
  const hierarchyNodes: NodeT[] = useMemo(() => {
    const built = rows.map((p, i) => {
      const email = normalizeEmail(p.workEmail);
      const id = email || `name:${p.name.toLowerCase()}:${i}`;
      return {
        id,
        parentId: normalizeEmail(p.managerEmail) || null,
        name: p.name || p.workEmail || "(no name)",
        email: p.workEmail,
        team: p.team,
        location: p.location,
        pod: p.pod,
        photoUrl:
          p.photoUrl ||
          `https://ui-avatars.com/api/?background=eee&color=555&name=${encodeURIComponent(
            p.name || "User"
          )}`,
      };
    });

    // orphan managers -> root
    const ids = new Set(built.map((n) => n.id));
    return built.map((n) => ({
      ...n,
      parentId: n.parentId && ids.has(n.parentId) ? n.parentId : null,
    }));
  }, [rows]);

  // build pod view nodes
  const podNodes: NodeT[] = useMemo(() => {
    if (!hierarchyNodes.length) return [];

    // pick a single “company root” if possible: node with parentId null and having many descendants
    // fallback to first root
    const roots = hierarchyNodes.filter((n) => !n.parentId);
    const companyRoot = roots[0] || hierarchyNodes[0];

    // group people by pod (use Pod column; empty -> "Unassigned")
    const people = hierarchyNodes.map((n) => ({
      ...n,
      pod: (n.pod || "").trim(),
    }));

    const podKeyOf = (n: NodeT) => (n.pod || "").trim() || "Unassigned";

    const pods = new Map<string, NodeT[]>();
    for (const n of people) {
      const k = podKeyOf(n);
      if (!pods.has(k)) pods.set(k, []);
      pods.get(k)!.push(n);
    }

    // helper to know if manager is inside same pod
    const byId = new Map<string, NodeT>();
    for (const n of people) byId.set(n.id, n);

    // create synthetic pod nodes under companyRoot
    const podSyntheticNodes: NodeT[] = [];
    const reparentedPeople: NodeT[] = [];

    for (const [podKey, members] of pods.entries()) {
      const podId = `pod:${podKey.toLowerCase()}`;

      // pod count = total people in that pod (INCLUDING pod lead(s))
      const podCount = members.length;

      podSyntheticNodes.push({
        id: podId,
        parentId: companyRoot.id, // podlar CEO/root altında
        name: podKey,
        isPod: true,
        podKey,
        podCount,
      });

      // re-parent only “pod roots”: people whose manager is outside pod OR missing
      const memberIds = new Set(members.map((m) => m.id));

      for (const m of members) {
        const mgrId = m.parentId;
        const mgrInsideSamePod = mgrId ? memberIds.has(mgrId) : false;

        // If manager isn't in same pod, attach to pod node
        if (!mgrInsideSamePod) {
          reparentedPeople.push({
            ...m,
            parentId: podId,
          });
        } else {
          reparentedPeople.push(m);
        }
      }
    }

    // ensure company root stays root (not forced under a pod)
    const finalPeople = reparentedPeople.map((n) =>
      n.id === companyRoot.id ? { ...n, parentId: null } : n
    );

    // combine: root + pods + people
    // IMPORTANT: companyRoot already in finalPeople
    return [...podSyntheticNodes, ...finalPeople];
  }, [hierarchyNodes]);

  const nodesToRender = view === "pod" ? podNodes : hierarchyNodes;

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
      const mod = await import("d3-org-chart");
      const OrgChart = (mod as any).OrgChart;

      if (cancelled || !chartRef.current) return;

      const chart = new OrgChart()
        .container(chartRef.current)
        .data(nodesToRender)
        .nodeWidth(() => 360)
        .nodeHeight(() => 120)
        .childrenMargin(() => 60)
        .compactMarginBetween(() => 40)
        .compactMarginPair(() => 90)

        // Button content: POD = total podCount; PERSON = direct reports count
        .buttonContent((d: any) => {
          const p = d.node.data as NodeT;
          const direct = d.node.children ? d.node.children.length : 0;
          const count = p.isPod ? (p.podCount || 0) : direct;

          if (!count) return "";

          return `
            <div style="
              padding:2px 8px;border-radius:999px;
              background:#fff;border:1px solid rgba(0,0,0,0.10);
              font-size:12px;font-weight:800;color:#111827;
            ">
              ${count}
            </div>
          `;
        })

        // When clicking POD node: expand entire subtree at once (pod roots + their descendants)
        .onNodeClick((d: any) => {
          const p = d.data as NodeT;
          if (!p.isPod) return;

          // expand this pod node and ALL descendants
          // d3-org-chart exposes setExpanded / expandAll usually; we use a safe approach:
          try {
            chart.setExpanded(p.id, true);

            // expand all descendants by scanning current data graph
            const data: NodeT[] = chart.data();
            const childrenByParent = new Map<string, string[]>();
            for (const n of data) {
              if (!n.parentId) continue;
              if (!childrenByParent.has(n.parentId)) childrenByParent.set(n.parentId, []);
              childrenByParent.get(n.parentId)!.push(n.id);
            }

            const stack = [...(childrenByParent.get(p.id) || [])];
            while (stack.length) {
              const id = stack.pop()!;
              chart.setExpanded(id, true);
              const kids = childrenByParent.get(id) || [];
              for (const k of kids) stack.push(k);
            }

            chart.render();
          } catch {
            // fallback: at least expand the pod itself
            try {
              chart.setExpanded(p.id, true).render();
            } catch {}
          }
        })

        .nodeContent((d: any) => {
          const p = d.data as NodeT;

          // POD NODE
          if (p.isPod) {
            return `
              <div style="
                width:360px;height:90px;background:${LILAC_BG};
                border:1px solid rgba(0,0,0,0.10);
                border-radius:18px;box-shadow:0 6px 18px rgba(0,0,0,0.06);
                display:flex;align-items:center;justify-content:center;
                position:relative; overflow:hidden;
              ">
                <div style="position:absolute;left:0;top:0;bottom:0;width:8px;background:${LILAC};"></div>
                <div style="
                  font-weight:900;font-size:20px;color:#111827;
                  padding:0 16px; text-align:center;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:330px;
                ">
                  ${p.name}
                </div>
              </div>
            `;
          }

          const img = p.photoUrl
            ? `<img src="${p.photoUrl}" crossorigin="anonymous"
                 style="width:64px;height:64px;border-radius:16px;object-fit:cover;border:1px solid rgba(0,0,0,0.12)" />`
            : `<div style="width:64px;height:64px;border-radius:16px;background:rgba(0,0,0,0.06);
                 display:flex;align-items:center;justify-content:center;font-weight:800;">
               ${String(p.name).trim().slice(0, 1).toUpperCase()}
             </div>`;

          // PERSON NODE: only 4 lines (Name, Team, Location, Email)
          return `
            <div style="
              width:360px;height:120px;background:#fff;
              border:1px solid rgba(0,0,0,0.12);
              border-radius:18px;box-shadow:0 8px 22px rgba(0,0,0,0.08);
              padding:14px;display:flex;gap:12px;align-items:center;
              position:relative; overflow:hidden;
            ">
              <div style="position:absolute;left:0;top:0;bottom:0;width:8px;background:${LILAC};"></div>

              ${img}
              <div style="display:flex;flex-direction:column;gap:6px;min-width:0;flex:1;">
                <div style="
                  font-weight:950;font-size:18px;line-height:1.1;color:#111827;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${p.name}
                </div>
                <div style="
                  font-size:13px;font-weight:800;color:#111827;
                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                ">
                  ${p.team || ""}
                </div>
                <div style="
                  font-size:13px;font-weight:800;color:#374151;
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

      // initial view niceness
      chart.fit();
      if (view === "pod") chart.collapseAll();
    })();

    return () => {
      cancelled = true;
    };
  }, [nodesToRender, view]);

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

    // reload
    const csv = await (await fetch("/api/org")).text();
    Papa.parse<RawRow>(csv, {
      header: true,
      skipEmptyLines: true,
      complete: (parsed) => {
        const data = (parsed.data || []) as RawRow[];
        const mapped: Person[] = data.map((r) => ({
          name: getStr(r, ["Name"]),
          workEmail: getStr(r, ["Work Email", "WorkEmail", "Email"]),
          managerEmail: getStr(r, ["Manager Email", "ManagerEmail"]),
          team: getStr(r, ["Team"]),
          location: getStr(r, ["Location", "Country"]),
          photoUrl: ensureHttps(getStr(r, ["Photo URL", "PhotoURL"])),
          pod: getStr(r, ["Pod", "POD", "pod"]),
        }));
        setRows(mapped);
      },
      error: (err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
    });
  }

  return (
    <div style={{ padding: 20, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto" }}>
      <h1 style={{ fontSize: 26, fontWeight: 900, margin: "0 0 16px 0" }}>
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
          onClick={() => setView("hierarchy")}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid rgba(0,0,0,0.12)",
            background: view === "hierarchy" ? LILAC_BG : "#fff",
            fontWeight: 800,
          }}
        >
          Hierarchy view
        </button>

        <button
          onClick={() => setView("pod")}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid rgba(0,0,0,0.12)",
            background: view === "pod" ? LILAC_BG : "#fff",
            fontWeight: 800,
          }}
        >
          Pod view
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
        CSV headers expected: Name, Work Email, Manager Email, Team, Location, Photo URL (optional: Pod)
      </div>
    </div>
  );
}

