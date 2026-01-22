import { NextResponse } from "next/server";
import { put, list, del } from "@vercel/blob";

const FILE_KEY = "org.csv";

export async function GET() {
  const { blobs } = await list({ prefix: FILE_KEY });

  if (!blobs.length) {
    return new NextResponse("No org.csv uploaded yet.", { status: 404 });
  }

  const latest = blobs.sort((a, b) => (a.uploadedAt > b.uploadedAt ? -1 : 1))[0];
  const res = await fetch(latest.url);
  const text = await res.text();

  return new NextResponse(text, {
    headers: { "content-type": "text/csv; charset=utf-8" },
  });
}

export async function POST(req: Request) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return NextResponse.json({ error: "ADMIN_PASSWORD not set" }, { status: 500 });
  }

  const provided = req.headers.get("x-admin-password") || "";
  if (provided !== adminPassword) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const form = await req.formData();
  const file = form.get("file");

  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  // delete older versions
  const { blobs } = await list({ prefix: FILE_KEY });
  for (const b of blobs) await del(b.url);

  const buf = Buffer.from(await file.arrayBuffer());
  const blob = await put(FILE_KEY, buf, {
    access: "public",
    contentType: "text/csv",
  });

  return NextResponse.json({ ok: true, url: blob.url });
}
